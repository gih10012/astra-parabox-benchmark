import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { AuditLog, createRunId } from "./audit-log.js";
import { ChallengeState } from "./challenge-state.js";
import { extractTokenUsage, publicTranscriptEvent } from "./codex-events.js";
import { runCommand } from "./command.js";
import { ArenaController } from "./controller.js";
import { defaultGamePaths } from "./doctor.js";
import { NiriGameAdapter } from "./game-adapter.js";
import { loadProviderConfig } from "./provider-config.js";
import { RolloutTailer } from "./rollout-tailer.js";
import { SaveGuard } from "./save-guard.js";
import { parseParaboxSave } from "./save-parser.js";
import { TARGET_LEVELS, type LevelProgress } from "./types.js";

export const NEUTRAL_PROMPT =
  "Complete all 364 official levels in Patrick's Parabox. Interact only through the provided tools.";

export interface RunOptions {
  rootDirectory: string;
  port?: number;
  reasoningEffort?: "low" | "medium" | "high" | "xhigh" | "max";
  record?: boolean;
  openDashboard?: boolean;
  isolateSaves?: boolean;
  output?: string;
}

export async function runChallenge(options: RunOptions): Promise<string> {
  const runId = createRunId();
  const runDirectory = path.resolve(
    options.output ?? path.join(options.rootDirectory, "runs", runId),
  );
  const frameDirectory = path.join(runDirectory, "frames");
  const mcpEntry = path.join(options.rootDirectory, "dist/src/mcp.js");
  await access(mcpEntry);
  const workDirectory = await mkdtemp(path.join(os.tmpdir(), "astra-parabox-"));
  await mkdir(frameDirectory, { recursive: true });

  const paths = defaultGamePaths();
  const audit = new AuditLog(runDirectory);
  const state = new ChallengeState("gpt-6-astra", TARGET_LEVELS);
  const game = new NiriGameAdapter({ frameDirectory });
  const controller = new ArenaController({
    state,
    game,
    port: options.port ?? 4317,
    webRoot: path.join(options.rootDirectory, "web"),
  });
  const saveGuard = new SaveGuard(paths.saveDirectory, runDirectory);
  const reasoningEffort = options.reasoningEffort ?? "high";
  const runConfig = {
    runId,
    createdAt: new Date().toISOString(),
    model: "gpt-6-astra",
    reasoningEffort,
    prompt: NEUTRAL_PROMPT,
    targetLevels: TARGET_LEVELS,
    observationPolicy: "pixels-only",
    actionPolicy: "keyboard-only",
    webSearch: "disabled",
    shellTool: false,
    saveIsolation: options.isolateSaves !== false,
    recording: options.record !== false,
  };
  await audit.initialize(runConfig);

  let codex: ChildProcess | null = null;
  let recorder: ChildProcess | null = null;
  let browser: ChildProcess | null = null;
  let gameLauncher: ChildProcess | null = null;
  const tailers = new Set<RolloutTailer>();
  let savePoll: NodeJS.Timeout | null = null;
  let restored = false;

  try {
    if (options.isolateSaves !== false) {
      await saveGuard.prepare();
      await audit.append("save.isolated", { directory: paths.saveDirectory });
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
    const gameWindow = await waitForGame(game);
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

    if (options.openDashboard !== false) {
      browser = spawn(
        "google-chrome-stable",
        [
          `--user-data-dir=${path.join(workDirectory, "chrome-profile")}`,
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

    if (options.record !== false) {
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
          path.join(runDirectory, "challenge.mkv"),
        ],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      await delay(1_000);
      if (recorder.exitCode !== null) throw new Error("wf-recorder exited early");
      await audit.append("recording.started", { output });
    }

    state.start(runId);
    await audit.append("challenge.started", state.snapshot());
    savePoll = setInterval(() => {
      void readBestProgress(paths.saveDirectory).then((progress) => {
        if (!progress) return;
        state.ingestSave(progress.text);
      });
    }, 350);

    const provider = await loadProviderConfig();
    const args = codexArguments({
      mcpEntry,
      arenaUrl: url,
      controlToken: controller.controlToken,
      reasoningEffort,
      providerAssignments: provider?.assignments ?? [],
    });
    await writeFile(
      path.join(runDirectory, "codex-command.json"),
      `${JSON.stringify({ command: "codex", args: redactControlToken(args) }, null, 2)}\n`,
    );
    codex = spawn("codex", args, {
      cwd: workDirectory,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stderrStream = codex.stderr;
    stderrStream?.on("data", (chunk: Buffer) => {
      void audit.appendRaw("codex-stderr.log", chunk.toString("utf8").trimEnd());
    });

    const stdoutLines = readline.createInterface({ input: codex.stdout! });
    stdoutLines.on("line", (line) => {
      void (async () => {
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
        if (root.type === "thread.started" && typeof root.thread_id === "string") {
          for (const activeTailer of tailers) activeTailer.stop();
          const tailer = new RolloutTailer(root.thread_id);
          tailers.add(tailer);
          void tailer.follow(async (rolloutEvent, raw) => {
            state.ingestCodexEvent(rolloutEvent);
            if (extractTokenUsage(rolloutEvent)) {
              await audit.appendRaw("codex-usage.jsonl", raw);
            }
          });
        }
      })();
    });

    const exitPromise = once(codex, "exit").then(([code, signal]) => ({
      code: typeof code === "number" ? code : null,
      signal: typeof signal === "string" ? signal : null,
    }));
    const finishPromise = once(state, "finished").then(
      ([snapshot]) => snapshot as ReturnType<ChallengeState["snapshot"]>,
    );
    const first = await Promise.race([
      exitPromise.then((exit) => ({ type: "exit" as const, exit })),
      finishPromise.then((snapshot) => ({ type: "finish" as const, snapshot })),
    ]);
    if (first.type === "exit" && state.snapshot().status === "running") {
      state.fail(`Codex exited before completion (code=${first.exit.code}, signal=${first.exit.signal})`);
    } else if (first.type === "finish" && first.snapshot.status === "completed") {
      const exit = await Promise.race([exitPromise, delay(8_000).then(() => null)]);
      if (!exit && codex.exitCode === null) codex.kill("SIGINT");
    }
    if (codex.exitCode === null) await Promise.race([exitPromise, delay(5_000)]);
    await audit.append("challenge.finished", state.snapshot());
  } catch (error) {
    if (state.snapshot().status === "running") {
      state.fail(error instanceof Error ? error.message : String(error));
    }
    await audit.append("run.error", {
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : null,
    });
    throw error;
  } finally {
    for (const tailer of tailers) tailer.stop();
    if (savePoll) clearInterval(savePoll);
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
    await rm(workDirectory, { recursive: true, force: true }).catch(() => undefined);
    if (options.isolateSaves !== false) {
      await saveGuard.restore();
      restored = true;
    }
    await audit.finalize({ ...state.snapshot(), savesRestored: restored });
  }
  return runDirectory;
}

export function codexArguments(options: {
  mcpEntry: string;
  arenaUrl: string;
  controlToken: string;
  reasoningEffort: string;
  providerAssignments?: Array<{ key: string; tomlValue: string }>;
  prompt?: string;
}): string[] {
  const config = (key: string, value: string) => ["-c", `${key}=${value}`];
  return [
    "exec",
    "--strict-config",
    "--json",
    "--model",
    "gpt-6-astra",
    "--color",
    "never",
    "--sandbox",
    "read-only",
    "--ignore-user-config",
    "--ignore-rules",
    "--skip-git-repo-check",
    ...(options.providerAssignments ?? []).flatMap(({ key, tomlValue }) =>
      config(key, tomlValue),
    ),
    ...config("approval_policy", '"never"'),
    ...config("web_search", '"disabled"'),
    ...config("tools.web_search", "false"),
    ...config("agents.enabled", "false"),
    ...config("features.multi_agent", "false"),
    ...config("features.shell_tool", "false"),
    ...config("features.apps", "false"),
    ...config("features.remote_plugin", "false"),
    ...config("features.browser_use", "false"),
    ...config("features.computer_use", "false"),
    ...config("features.image_generation", "false"),
    ...config("features.skill_search", "false"),
    ...config("features.memories", "false"),
    ...config("features.hooks", "false"),
    ...config("check_for_update_on_startup", "false"),
    ...config("model_reasoning_effort", `"${options.reasoningEffort}"`),
    ...config("mcp_servers.parabox.command", '"node"'),
    ...config("mcp_servers.parabox.args", JSON.stringify([options.mcpEntry])),
    ...config(
      "mcp_servers.parabox.env",
      `{ARENA_URL=${JSON.stringify(options.arenaUrl)},ARENA_CONTROL_TOKEN=${JSON.stringify(options.controlToken)}}`,
    ),
    ...config("mcp_servers.parabox.required", "true"),
    ...config(
      "mcp_servers.parabox.enabled_tools",
      JSON.stringify([
        "observe_game",
        "press_keys",
        "challenge_time",
        "challenge_tokens",
      ]),
    ),
    options.prompt ?? NEUTRAL_PROMPT,
  ];
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
): Promise<{ windowId: number; title: string }> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
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

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
