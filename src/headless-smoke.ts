import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { ChallengeState } from "./challenge-state.js";
import { runCommand } from "./command.js";
import { ArenaController } from "./controller.js";
import { defaultGamePaths } from "./doctor.js";
import { X11GameAdapter } from "./game-adapter.js";
import {
  hiddenRecorderArguments,
  startVirtualDashboard,
  startVirtualGame,
  startVirtualGameMirror,
  type VirtualDashboardRuntime,
} from "./headless-display.js";
import { TARGET_LEVELS } from "./types.js";

export async function runHeadlessSmoke(rootDirectory: string): Promise<{
  display: string;
  windowId: number;
  title: string;
  before: { filename: string; sha256: string };
  after: { filename: string; sha256: string };
  recording: { filename: string; bytes: number; durationSeconds: number };
}> {
  const output = path.join(
    rootDirectory,
    ".arena",
    `headless-smoke-${new Date().toISOString().replaceAll(/[:.]/g, "-")}`,
  );
  const frameDirectory = path.join(output, "frames");
  const runtimeDirectory = path.join(output, "runtime");
  await mkdir(frameDirectory, { recursive: true });
  await mkdir(runtimeDirectory, { recursive: true });
  const runtime = await startVirtualGame({
    rootDirectory,
    runtimeDirectory,
    executable: defaultGamePaths().executable,
  });
  const game = new X11GameAdapter({
    display: runtime.display,
    frameDirectory,
    keypressCommand: runtime.keypressCommand,
    compositorScreenshot: runtime.compositorScreenshot,
  });
  let controller: ArenaController | null = null;
  let dashboard: VirtualDashboardRuntime | null = null;
  let gameMirror: VirtualDashboardRuntime | null = null;
  let recorder: ChildProcess | null = null;
  try {
    const discovered = await waitForGame(game, 120_000);
    await delay(18_000);
    const before = await game.capture();
    await assertVisibleFrame(path.join(frameDirectory, "00000001.jpg"));
    const state = new ChallengeState("gpt-6-astra", TARGET_LEVELS);
    controller = new ArenaController({
      state,
      game,
      port: 0,
      webRoot: path.join(rootDirectory, "web"),
    });
    const url = await controller.listen();
    state.start("headless-smoke");
    state.ingestCodexEvent({
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: {
            input_tokens: 12840,
            cached_input_tokens: 8192,
            output_tokens: 756,
            reasoning_output_tokens: 410,
            total_tokens: 13596,
          },
        },
      },
    });
    controller.publishTranscript({ type: "turn.started" });
    controller.publishTranscript({
      type: "item.completed",
      item: {
        type: "reasoning",
        text: "Verifying the isolated game, controls, dashboard, and recorder.",
      },
    });
    await fetch(new URL("/internal/observe", url), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${controller.controlToken}`,
        "Content-Type": "application/json",
      },
      body: "{}",
    });
    dashboard = await startVirtualDashboard({
      rootDirectory,
      runtimeDirectory,
      url,
    });
    gameMirror = await startVirtualGameMirror({
      rootDirectory,
      runtimeDirectory,
      url,
    });
    const recordingPath = path.join(output, "headless-smoke.mkv");
    recorder = spawn(
      "ffmpeg",
      hiddenRecorderArguments({
        gameDisplay: gameMirror.display,
        dashboardDisplay: dashboard.display,
        output: recordingPath,
      }),
      { stdio: "ignore" },
    );
    await delay(1_000);
    await game.press(["ENTER"], { intervalMs: 0, settleMs: 1_800 });
    const after = await game.capture();
    controller.publishFrame(after);
    await game.press(["DOWN"], { intervalMs: 80, settleMs: 500 });
    controller.publishFrame(await game.capture());
    await game.press(["UP"], { intervalMs: 80, settleMs: 100 });
    await delay(2_000);
    if (recorder.exitCode !== null) throw new Error("Headless smoke recorder exited early");
    recorder.kill("SIGINT");
    await Promise.race([once(recorder, "exit"), delay(5_000)]);
    recorder = null;
    const recordingSize = (await stat(recordingPath)).size;
    const durationSeconds = await validateRecording(recordingPath);
    return {
      display: runtime.display,
      ...discovered,
      before: {
        filename: path.join(frameDirectory, "00000001.jpg"),
        sha256: before.sha256,
      },
      after: {
        filename: path.join(frameDirectory, "00000003.jpg"),
        sha256: after.sha256,
      },
      recording: {
        filename: recordingPath,
        bytes: recordingSize,
        durationSeconds,
      },
    };
  } finally {
    if (recorder?.exitCode === null) recorder.kill("SIGINT");
    await gameMirror?.close().catch(() => undefined);
    await dashboard?.close().catch(() => undefined);
    await controller?.close().catch(() => undefined);
    await game.close().catch(() => undefined);
    await runtime.close();
  }
}

async function assertVisibleFrame(filename: string): Promise<void> {
  const result = await runCommand("ffmpeg", [
    "-nostdin", "-hide_banner", "-loglevel", "info",
    "-i", filename,
    "-vf", "signalstats,metadata=print",
    "-frames:v", "1",
    "-f", "null", "-",
  ]);
  const output = `${result.stdout.toString("utf8")}\n${result.stderr.toString("utf8")}`;
  const maximum = Number(/lavfi\.signalstats\.YMAX=([\d.]+)/.exec(output)?.[1]);
  if (result.code !== 0 || !Number.isFinite(maximum) || maximum <= 1) {
    throw new Error("Gamescope returned a blank game frame");
  }
}

async function validateRecording(filename: string): Promise<number> {
  const probe = await runCommand("ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "default=nw=1:nk=1",
    filename,
  ]);
  const duration = Number(probe.stdout.toString("utf8").trim());
  if (probe.code !== 0 || duration < 5.5 || duration > 7.5) {
    throw new Error(`Unexpected smoke recording duration: ${duration}`);
  }
  const decode = await runCommand("ffmpeg", [
    "-nostdin", "-v", "error", "-i", filename, "-f", "null", "-",
  ], { timeoutMs: 30_000 });
  if (decode.code !== 0 || decode.stderr.length > 0) {
    throw new Error(`Smoke recording decode failed: ${decode.stderr.toString("utf8")}`);
  }
  return duration;
}

async function waitForGame(
  game: X11GameAdapter,
  timeoutMs: number,
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

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
