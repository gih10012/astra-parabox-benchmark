import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import {
  access,
  mkdir,
  readFile,
  readdir,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { AuditLog, createRunId } from "./audit-log.js";
import { ChallengeState } from "./challenge-state.js";
import {
  codexEnvironment,
  displayCodexHome,
  resolveCodexHome,
} from "./codex-home.js";
import {
  emptyTokenUsage,
  extractTokenUsage,
  publicTranscriptEvent,
} from "./codex-events.js";
import { runCommand } from "./command.js";
import { ArenaController } from "./controller.js";
import { defaultGamePaths } from "./doctor.js";
import { NiriGameAdapter } from "./game-adapter.js";
import { RolloutTailer } from "./rollout-tailer.js";
import {
  CheckpointStore,
  checkpointPath,
  clearActiveRun,
  processMatches,
  processStartTicks,
  registerActiveRun,
  type RunCheckpoint,
  type RunPhase,
} from "./run-checkpoint.js";
import { SaveGuard } from "./save-guard.js";
import { parseParaboxSave } from "./save-parser.js";
import { TARGET_LEVELS, type LevelProgress } from "./types.js";

export const NEUTRAL_PROMPT =
  "Complete all 364 official levels in Patrick's Parabox. Use the Parabox tools for game observation and control. Do not search or browse the internet.";
export const RESUME_PROMPT =
  "Continue the same task from the current game state. Do not search or browse the internet.";

const DEFAULT_QUOTA_WAIT_MS = 5 * 60 * 60 * 1_000;

export interface RunOptions {
  rootDirectory: string;
  port?: number;
  reasoningEffort?: "low" | "medium" | "high" | "xhigh" | "max";
  record?: boolean;
  openDashboard?: boolean;
  isolateSaves?: boolean;
  output?: string;
  codexHome?: string;
  quotaWaitMs?: number;
}

export interface RunOutcome {
  runDirectory: string;
  phase: RunPhase;
  retryAt: string | null;
  reason: string | null;
}

export async function runChallenge(options: RunOptions): Promise<RunOutcome> {
  const runId = createRunId();
  const runDirectory = path.resolve(
    options.output ?? path.join(options.rootDirectory, "runs", runId),
  );
  const rootDirectory = path.resolve(options.rootDirectory);
  const codexHome = await resolveCodexHome(options.codexHome);
  const now = new Date().toISOString();
  const persistedOptions: RunCheckpoint["options"] = {
    rootDirectory,
    port: options.port ?? 4317,
    reasoningEffort: options.reasoningEffort ?? "high",
    record: options.record !== false,
    openDashboard: options.openDashboard !== false,
    isolateSaves: options.isolateSaves !== false,
    quotaWaitMs: options.quotaWaitMs ?? DEFAULT_QUOTA_WAIT_MS,
    ...(codexHome ? { codexHome } : {}),
  };
  const initialCheckpoint: RunCheckpoint = {
    version: 1,
    runId,
    runDirectory,
    createdAt: now,
    updatedAt: now,
    phase: "starting",
    attempt: 0,
    pid: process.pid,
    pidStartTicks: processStartTicks(),
    threadId: null,
    retryAt: null,
    reason: null,
    savePrepared: false,
    elapsedMs: 0,
    startedAt: null,
    tokens: emptyTokenUsage(),
    progress: { total: 0, unlocked: 0, completed: 0 },
    recordings: [],
    options: persistedOptions,
  };
  const audit = new AuditLog(runDirectory);
  const runConfig = {
    runId,
    createdAt: now,
    model: "gpt-6-astra",
    reasoningEffort: persistedOptions.reasoningEffort,
    prompt: NEUTRAL_PROMPT,
    resumePrompt: RESUME_PROMPT,
    targetLevels: TARGET_LEVELS,
    observationPolicy: "pixels-only",
    actionPolicy: "keyboard-only",
    webSearch: "disabled",
    networkBrowser: "disabled",
    shellNetwork: "disabled",
    standardCodexCapabilities: true,
    codexHome: displayCodexHome(codexHome),
    saveIsolation: persistedOptions.isolateSaves,
    recording: persistedOptions.record,
    resumable: true,
    quotaWaitMs: persistedOptions.quotaWaitMs,
  };
  await audit.initialize(runConfig);
  const checkpoint = new CheckpointStore(
    checkpointPath(runDirectory),
    initialCheckpoint,
  );
  await checkpoint.update({});
  await registerActiveRun(rootDirectory, runDirectory);
  return await runAttempt(checkpoint);
}

export async function resumeChallenge(runDirectory: string): Promise<RunOutcome> {
  const checkpoint = await CheckpointStore.load(runDirectory);
  const current = checkpoint.snapshot();
  if (current.phase === "completed" || current.phase === "failed") {
    throw new Error(`Run is already ${current.phase}: ${current.runDirectory}`);
  }
  if (
    (current.phase === "running" || current.phase === "starting") &&
    current.pid !== null &&
    processMatches(current.pid, current.pidStartTicks)
  ) {
    throw new Error(`Run is already active with PID ${current.pid}`);
  }
  await registerActiveRun(current.options.rootDirectory, current.runDirectory);
  return await runAttempt(checkpoint);
}

export async function cancelChallenge(runDirectory: string): Promise<RunOutcome> {
  const checkpoint = await CheckpointStore.load(runDirectory);
  const current = checkpoint.snapshot();
  if (current.phase === "completed" || current.phase === "failed") {
    throw new Error(`Run is already ${current.phase}: ${current.runDirectory}`);
  }
  if (
    (current.phase === "running" || current.phase === "starting") &&
    current.pid !== null &&
    processMatches(current.pid, current.pidStartTicks)
  ) {
    throw new Error(`Stop active PID ${current.pid} before cancelling the run`);
  }
  let restored = false;
  if (current.options.isolateSaves && current.savePrepared) {
    const saveGuard = new SaveGuard(defaultGamePaths().saveDirectory, current.runDirectory);
    await saveGuard.load();
    await saveGuard.restore();
    restored = true;
  }
  const reason = "Cancelled by operator";
  await checkpoint.update({
    phase: "failed",
    pid: null,
    pidStartTicks: null,
    retryAt: null,
    reason,
  });
  const audit = new AuditLog(current.runDirectory);
  await audit.append("challenge.cancelled", { reason, savesRestored: restored });
  await audit.finalize({
    status: "failed",
    reason,
    checkpoint: checkpoint.snapshot(),
    savesRestored: restored,
  });
  await clearActiveRun(current.options.rootDirectory, current.runDirectory);
  return {
    runDirectory: current.runDirectory,
    phase: "failed",
    retryAt: null,
    reason,
  };
}

async function runAttempt(checkpointStore: CheckpointStore): Promise<RunOutcome> {
  const prior = checkpointStore.snapshot();
  const attempt = prior.attempt + 1;
  const part = String(attempt).padStart(4, "0");
  const runDirectory = prior.runDirectory;
  const rootDirectory = prior.options.rootDirectory;
  const frameDirectory = path.join(runDirectory, "frames", `part-${part}`);
  const runtimeDirectory = path.join(runDirectory, "runtime", `part-${part}`);
  const workDirectory = path.join(runDirectory, "workspace");
  const recordingRelative = path.join("recordings", `challenge-part-${part}.mkv`);
  const recordingPath = path.join(runDirectory, recordingRelative);
  const mcpEntry = path.join(rootDirectory, "dist/src/mcp.js");
  await access(mcpEntry);
  await mkdir(frameDirectory, { recursive: true });
  await mkdir(runtimeDirectory, { recursive: true });
  await mkdir(workDirectory, { recursive: true });
  await mkdir(path.dirname(recordingPath), { recursive: true });

  const paths = defaultGamePaths();
  const audit = new AuditLog(runDirectory);
  const state = new ChallengeState("gpt-6-astra", TARGET_LEVELS, attempt);
  const game = new NiriGameAdapter({ frameDirectory });
  const controller = new ArenaController({
    state,
    game,
    port: prior.options.port,
    webRoot: path.join(rootDirectory, "web"),
  });
  const saveGuard = new SaveGuard(paths.saveDirectory, runDirectory);
  const codexHome = prior.options.codexHome;
  const sessionsRoot = path.join(
    codexHome ?? path.join(os.homedir(), ".codex"),
    "sessions",
  );
  await checkpointStore.update({
    phase: "starting",
    attempt,
    pid: process.pid,
    pidStartTicks: processStartTicks(),
    retryAt: null,
    reason: null,
  });
  await audit.append("attempt.started", { attempt, resumed: attempt > 1 });

  let codex: ChildProcess | null = null;
  let recorder: ChildProcess | null = null;
  let browser: ChildProcess | null = null;
  let gameLauncher: ChildProcess | null = null;
  const tailers = new Set<RolloutTailer>();
  const tailerTasks = new Set<Promise<void>>();
  const eventTasks = new Set<Promise<void>>();
  let savePoll: NodeJS.Timeout | null = null;
  let checkpointPoll: NodeJS.Timeout | null = null;
  const checkpointWork: { current: Promise<void> | null } = { current: null };
  let checkpointBusy = false;
  let restored = false;
  let quotaExhausted = false;
  let exitDescription = "Codex exited before completion";
  let requestedStop: "pause" | "restart" | null = null;
  let outcomePhase: RunPhase = "waiting_retry";
  let retryAt: string | null = null;
  let reason: string | null = null;

  const inspectDiagnostic = (text: string) => {
    if (isQuotaError(text)) quotaExhausted = true;
  };
  const stopCodex = () => {
    if (codex?.exitCode === null) codex.kill("SIGINT");
  };
  const onInterrupt = () => {
    requestedStop = "pause";
    stopCodex();
  };
  const onTerminate = () => {
    requestedStop = "restart";
    stopCodex();
  };
  process.once("SIGINT", onInterrupt);
  process.once("SIGTERM", onTerminate);

  try {
    if (prior.options.isolateSaves) {
      if (prior.savePrepared) await saveGuard.resume();
      else {
        await saveGuard.prepare();
        await checkpointStore.update({ savePrepared: true });
        await audit.append("save.isolated", { directory: paths.saveDirectory });
      }
    }

    gameLauncher = spawn(
      "steam",
      [
        "-applaunch",
        "1260520",
        "-screen-fullscreen",
        "0",
        "-screen-width",
        "1120",
        "-screen-height",
        "960",
      ],
      { detached: false, stdio: "ignore" },
    );
    const gameWindow = await waitForGame(
      game,
      120_000,
      () => requestedStop !== null,
    );
    await audit.append("game.ready", gameWindow);

    const url = await controller.listen();
    await audit.append("controller.ready", { url });
    await fetch(new URL("/internal/observe", url), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${controller.controlToken}`,
        "Content-Type": "application/json",
      },
      body: "{}",
    });

    if (prior.options.openDashboard) {
      browser = spawn(
        "google-chrome-stable",
        [
          `--user-data-dir=${path.join(runtimeDirectory, "chrome-profile")}`,
          "--no-first-run",
          "--disable-session-crashed-bubble",
          `--app=${url}/?compact=1`,
        ],
        { stdio: "ignore" },
      );
      await arrangeWindows(gameWindow.windowId).catch(async (error: unknown) => {
        await audit.append("layout.warning", String(error));
      });
    }

    if (prior.options.record) {
      const output = await primaryOutput();
      recorder = spawn(
        "wf-recorder",
        [
          "-y",
          "-D",
          "-r",
          "30",
          "-o",
          output,
          "-f",
          recordingPath,
        ],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      await delay(1_000);
      if (recorder.exitCode !== null) throw new Error("wf-recorder exited early");
      await checkpointStore.update((current) => ({
        recordings: current.recordings.includes(recordingRelative)
          ? current.recordings
          : [...current.recordings, recordingRelative],
      }));
      await audit.append("recording.started", {
        attempt,
        output,
        filename: recordingRelative,
      });
    }

    state.start(prior.runId, Date.now(), process.hrtime.bigint(), {
      elapsedMs: prior.elapsedMs,
      startedAt: prior.startedAt,
      tokens: prior.tokens,
      progress: prior.progress,
    });
    const finishPromise = once(state, "finished").then(
      ([snapshot]) => snapshot as ReturnType<ChallengeState["snapshot"]>,
    );
    await checkpointStore.update({
      phase: "running",
      startedAt: state.timeSnapshot().startedAt,
    });
    await audit.append(attempt === 1 ? "challenge.started" : "challenge.resumed", {
      attempt,
      threadId: prior.threadId,
      snapshot: state.snapshot(),
    });
    const liveProgress = await readBestProgress(paths.saveDirectory);
    if (liveProgress) state.ingestSave(liveProgress.text);
    if (state.snapshot().status !== "completed") {
      savePoll = setInterval(() => {
        void readBestProgress(paths.saveDirectory).then((progress) => {
          if (!progress) return;
          state.ingestSave(progress.text);
        });
      }, 350);
      checkpointPoll = setInterval(() => {
        if (checkpointBusy) return;
        checkpointBusy = true;
        checkpointWork.current = persistAttemptCheckpoint(
          checkpointStore,
          state,
          prior.options.isolateSaves ? saveGuard : null,
        )
          .catch((error: unknown) => {
            void audit.append("checkpoint.warning", String(error));
          })
          .finally(() => {
            checkpointBusy = false;
          });
      }, 5_000);

      const args = codexArguments({
        mcpEntry,
        arenaUrl: url,
        controlToken: controller.controlToken,
        reasoningEffort: prior.options.reasoningEffort,
        ...(prior.threadId ? { resumeThreadId: prior.threadId } : {}),
      });
      await writeFile(
        path.join(runDirectory, `codex-command-part-${part}.json`),
        `${JSON.stringify({ command: "codex", args: redactControlToken(args) }, null, 2)}\n`,
      );
      codex = spawn("codex", args, {
        cwd: workDirectory,
        env: codexEnvironment(codexHome),
        stdio: ["ignore", "pipe", "pipe"],
      });
      const stderrStream = codex.stderr;
      stderrStream?.on("data", (chunk: Buffer) => {
        const text = chunk.toString("utf8").trimEnd();
        inspectDiagnostic(text);
        void audit.appendRaw(`codex-stderr-part-${part}.log`, text);
      });

      const stdoutLines = readline.createInterface({ input: codex.stdout! });
      stdoutLines.on("line", (line) => {
        const task = (async () => {
          await audit.appendRaw("codex-exec.jsonl", line);
          let event: unknown;
          try {
            event = JSON.parse(line);
          } catch {
            return;
          }
          state.ingestCodexEvent(event);
          const visible = publicTranscriptEvent(event);
          if (visible) controller.publishTranscript(visible);
          const root = event as Record<string, unknown>;
          if (root.type === "error" || root.type === "turn.failed") {
            inspectDiagnostic(line);
          }
          if (
            root.type === "thread.started" &&
            typeof root.thread_id === "string"
          ) {
            await checkpointStore.update({ threadId: root.thread_id });
            for (const activeTailer of tailers) activeTailer.stop();
            const tailer = new RolloutTailer(root.thread_id, sessionsRoot);
            tailers.add(tailer);
            const tailerTask = tailer.follow(async (rolloutEvent, raw) => {
              state.ingestCodexEvent(rolloutEvent);
              if (extractTokenUsage(rolloutEvent)) {
                await audit.appendRaw("codex-usage.jsonl", raw);
              }
            });
            tailerTasks.add(tailerTask);
            void tailerTask
              .catch(() => undefined)
              .finally(() => tailerTasks.delete(tailerTask));
          }
        })();
        eventTasks.add(task);
        void task
          .catch(() => undefined)
          .finally(() => eventTasks.delete(task));
      });

      const exitPromise = once(codex, "exit").then(([code, signal]) => ({
        code: typeof code === "number" ? code : null,
        signal: typeof signal === "string" ? signal : null,
      }));
      const first = await Promise.race([
        exitPromise.then((exit) => ({ type: "exit" as const, exit })),
        finishPromise.then((snapshot) => ({ type: "finish" as const, snapshot })),
      ]);
      if (first.type === "exit" && state.snapshot().status === "running") {
        exitDescription = `Codex exited before completion (code=${first.exit.code}, signal=${first.exit.signal})`;
        state.stop();
      } else if (
        first.type === "finish" &&
        first.snapshot.status === "completed"
      ) {
        const exit = await Promise.race([
          exitPromise,
          delay(8_000).then(() => null),
        ]);
        if (!exit && codex.exitCode === null) codex.kill("SIGINT");
      }
      if (codex.exitCode === null) {
        await Promise.race([exitPromise, delay(5_000)]);
      }
      await Promise.allSettled([...eventTasks]);
    }
    if (state.snapshot().status === "completed") {
      outcomePhase = "completed";
    } else if (requestedStop === "pause") {
      outcomePhase = "paused";
      reason = "Paused by SIGINT";
    } else if (requestedStop === "restart") {
      outcomePhase = "waiting_retry";
      retryAt = new Date().toISOString();
      reason = "Interrupted by shutdown or service restart";
    } else if (quotaExhausted) {
      outcomePhase = "waiting_quota";
      retryAt = new Date(Date.now() + prior.options.quotaWaitMs).toISOString();
      reason = exitDescription;
    } else {
      outcomePhase = "waiting_retry";
      retryAt = new Date(Date.now() + retryDelayMs(attempt)).toISOString();
      reason = exitDescription;
    }
  } catch (error) {
    if (state.snapshot().status === "running") state.stop();
    reason = error instanceof Error ? error.message : String(error);
    outcomePhase = requestedStop === "pause" ? "paused" : "waiting_retry";
    retryAt = outcomePhase === "waiting_retry"
      ? new Date(
          Date.now() + (requestedStop === "restart" ? 0 : retryDelayMs(attempt)),
        ).toISOString()
      : null;
    await audit.append("run.error", {
      attempt,
      message: reason,
      stack: error instanceof Error ? error.stack : null,
    });
  } finally {
    process.off("SIGINT", onInterrupt);
    process.off("SIGTERM", onTerminate);
    for (const tailer of tailers) tailer.stop();
    await Promise.allSettled([...tailerTasks]);
    if (savePoll) clearInterval(savePoll);
    if (checkpointPoll) clearInterval(checkpointPoll);
    if (checkpointWork.current) {
      await checkpointWork.current.catch(() => undefined);
    }
    if (codex?.exitCode === null) codex.kill("SIGINT");
    if (recorder?.exitCode === null) {
      recorder.kill("SIGINT");
      await Promise.race([once(recorder, "exit"), delay(5_000)]).catch(() => undefined);
    }
    await game.close?.().catch(() => undefined);
    await delay(500);
    browser?.kill("SIGTERM");
    gameLauncher?.kill("SIGTERM");
    await controller.close().catch(() => undefined);
    if (prior.options.isolateSaves) {
      await saveGuard.checkpointChallenge().catch(async (error: unknown) => {
        await audit.append("checkpoint.save.warning", String(error));
      });
    }
    const snapshot = state.snapshot();
    const attemptStarted = snapshot.status !== "idle";
    const checkpointPhase =
      outcomePhase === "completed" && prior.options.isolateSaves
        ? "running"
        : outcomePhase;
    await checkpointStore.update({
      phase: checkpointPhase,
      pid: checkpointPhase === "running" ? process.pid : null,
      pidStartTicks:
        checkpointPhase === "running" ? processStartTicks() : null,
      retryAt,
      reason,
      elapsedMs: attemptStarted ? snapshot.time.elapsedMs : prior.elapsedMs,
      startedAt: attemptStarted
        ? snapshot.time.startedAt ?? prior.startedAt
        : prior.startedAt,
      tokens: attemptStarted ? snapshot.tokens : prior.tokens,
      progress: attemptStarted ? snapshot.progress : prior.progress,
    });
    await checkpointStore.flush();
    await audit.append("attempt.finished", {
      attempt,
      phase: outcomePhase,
      retryAt,
      reason,
      snapshot,
    });
    if (outcomePhase === "completed" && prior.options.isolateSaves) {
      await saveGuard.restore();
      restored = true;
    }
    if (outcomePhase === "completed") {
      await checkpointStore.update({
        phase: "completed",
        pid: null,
        pidStartTicks: null,
      });
      await audit.append("challenge.finished", snapshot);
      await audit.finalize({
        ...snapshot,
        attempts: attempt,
        continuity: attempt === 1 ? "continuous" : "resumed",
        wallElapsedMs: Math.max(0, Date.now() - Date.parse(prior.createdAt)),
        inactiveElapsedMs: Math.max(
          0,
          Date.now() - Date.parse(prior.createdAt) - snapshot.time.elapsedMs,
        ),
        recordings: checkpointStore.snapshot().recordings,
        savesRestored: restored,
      });
      await clearActiveRun(rootDirectory, runDirectory);
    }
  }
  const finished = checkpointStore.snapshot();
  return {
    runDirectory,
    phase: finished.phase,
    retryAt: finished.retryAt,
    reason: finished.reason,
  };
}

export function codexArguments(options: {
  mcpEntry: string;
  arenaUrl: string;
  controlToken: string;
  reasoningEffort: string;
  prompt?: string;
  resumeThreadId?: string;
}): string[] {
  const config = (key: string, value: string) => ["-c", `${key}=${value}`];
  const common = [
    "exec",
    "--json",
    "--model",
    "gpt-6-astra",
    "--color",
    "never",
    "--sandbox",
    "workspace-write",
    "--skip-git-repo-check",
    ...config("approval_policy", '"never"'),
    ...config("sandbox_workspace_write.network_access", "false"),
    ...config("web_search", '"disabled"'),
    ...config("tools.web_search", "false"),
    ...config("features.browser_use", "false"),
    ...config("features.browser_use_external", "false"),
    ...config("features.in_app_browser", "false"),
    ...config("model_reasoning_effort", `"${options.reasoningEffort}"`),
    ...config("mcp_servers.parabox.command", '"node"'),
    ...config("mcp_servers.parabox.args", JSON.stringify([options.mcpEntry])),
    ...config(
      "mcp_servers.parabox.env",
      `{ARENA_URL=${JSON.stringify(options.arenaUrl)},ARENA_CONTROL_TOKEN=${JSON.stringify(options.controlToken)}}`,
    ),
    ...config("mcp_servers.parabox.required", "true"),
    ...config("mcp_servers.parabox.default_tools_approval_mode", '"approve"'),
    ...config(
      "mcp_servers.parabox.enabled_tools",
      JSON.stringify([
        "observe_game",
        "press_keys",
        "challenge_time",
        "challenge_tokens",
      ]),
    ),
  ];
  return options.resumeThreadId
    ? [
        ...common,
        "resume",
        options.resumeThreadId,
        options.prompt ?? RESUME_PROMPT,
      ]
    : [...common, options.prompt ?? NEUTRAL_PROMPT];
}

function redactControlToken(args: string[]): string[] {
  return args.map((argument) =>
    argument.includes("ARENA_CONTROL_TOKEN")
      ? argument.replace(/ARENA_CONTROL_TOKEN="[^"]+"/, 'ARENA_CONTROL_TOKEN="<redacted>"')
      : argument,
  );
}

async function waitForGame(
  game: NiriGameAdapter,
  timeoutMs = 120_000,
  cancelled: () => boolean = () => false,
): Promise<{ windowId: number; title: string }> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    if (cancelled()) throw new Error("Interrupted while waiting for game window");
    try {
      return await game.discover();
    } catch (error) {
      lastError = error;
      await delay(500);
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Game window timeout");
}

async function arrangeWindows(gameWindowId: number): Promise<void> {
  const deadline = Date.now() + 20_000;
  let directorId: number | null = null;
  while (Date.now() < deadline && directorId === null) {
    const result = await runCommand("niri", ["msg", "--json", "windows"]);
    if (result.code === 0) {
      const windows = JSON.parse(result.stdout.toString("utf8")) as Array<{
        id: number;
        title: string;
      }>;
      directorId =
        windows.find((window) => /Astra.*Parabox Arena/i.test(window.title))?.id ??
        null;
    }
    if (directorId === null) await delay(250);
  }
  if (directorId === null) throw new Error("Director window not found");
  await runCommand("niri", [
    "msg",
    "action",
    "set-window-width",
    "--id",
    String(gameWindowId),
    "67%",
  ]);
  await runCommand("niri", [
    "msg",
    "action",
    "set-window-width",
    "--id",
    String(directorId),
    "33%",
  ]);
  await runCommand("niri", ["msg", "action", "focus-window", "--id", String(gameWindowId)]);
  await runCommand("niri", ["msg", "action", "center-visible-columns"]);
}

async function primaryOutput(): Promise<string> {
  const result = await runCommand("niri", ["msg", "--json", "outputs"]);
  if (result.code !== 0) throw new Error("Cannot read niri outputs");
  const outputs = JSON.parse(result.stdout.toString("utf8")) as Record<string, unknown>;
  const name = Object.keys(outputs)[0];
  if (!name) throw new Error("No connected output");
  return name;
}

async function readBestProgress(
  directory: string,
): Promise<{ text: string; progress: LevelProgress } | null> {
  let best: { text: string; progress: LevelProgress } | null = null;
  let names: string[];
  try {
    names = await readdir(directory);
  } catch {
    return null;
  }
  for (const name of names.filter((item) => /^save\d+\.txt$/i.test(item))) {
    try {
      const text = await readFile(path.join(directory, name), "utf8");
      const progress = parseParaboxSave(text);
      if (!best || progress.completed > best.progress.completed) {
        best = { text, progress };
      }
    } catch {
      // Save writes are not atomic; retry on the next poll.
    }
  }
  return best;
}

async function persistAttemptCheckpoint(
  checkpoint: CheckpointStore,
  state: ChallengeState,
  saveGuard: SaveGuard | null,
): Promise<void> {
  const snapshot = state.snapshot();
  await checkpoint.update({
    elapsedMs: snapshot.time.elapsedMs,
    startedAt: snapshot.time.startedAt,
    tokens: snapshot.tokens,
    progress: snapshot.progress,
  });
  if (saveGuard) await saveGuard.checkpointChallenge();
}

export function isQuotaError(text: string): boolean {
  return /(?:\b429\b|rate[_ -]?limit|usage limit|quota|too many requests|insufficient_quota|limit has been reached)/i.test(
    text,
  );
}

function retryDelayMs(attempt: number): number {
  return Math.min(30 * 60_000, 60_000 * 2 ** Math.min(8, attempt - 1));
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
