import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { ChallengeState } from "./challenge-state.js";
import { ArenaController } from "./controller.js";
import { defaultGamePaths } from "./doctor.js";
import { X11GameAdapter } from "./game-adapter.js";
import {
  hiddenRecorderArguments,
  startVirtualDashboard,
  startVirtualGame,
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
  });
  let controller: ArenaController | null = null;
  let dashboard: VirtualDashboardRuntime | null = null;
  let recorder: ChildProcess | null = null;
  try {
    const discovered = await waitForGame(game, 120_000);
    await delay(18_000);
    const before = await game.capture();
    await game.press(["DOWN"], { intervalMs: 80, settleMs: 500 });
    const after = await game.capture();
    await game.press(["UP"], { intervalMs: 80, settleMs: 100 });
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
    dashboard = await startVirtualDashboard({
      rootDirectory,
      runtimeDirectory,
      url,
    });
    const recordingPath = path.join(output, "headless-smoke.mkv");
    recorder = spawn(
      "ffmpeg",
      hiddenRecorderArguments({
        gameDisplay: runtime.display,
        gameWindowId: discovered.windowId,
        dashboardDisplay: dashboard.display,
        output: recordingPath,
      }),
      { stdio: "ignore" },
    );
    await delay(6_000);
    if (recorder.exitCode !== null) throw new Error("Headless smoke recorder exited early");
    recorder.kill("SIGINT");
    await Promise.race([once(recorder, "exit"), delay(5_000)]);
    recorder = null;
    const recordingSize = (await stat(recordingPath)).size;
    return {
      display: runtime.display,
      ...discovered,
      before: {
        filename: path.join(frameDirectory, "00000001.jpg"),
        sha256: before.sha256,
      },
      after: {
        filename: path.join(frameDirectory, "00000002.jpg"),
        sha256: after.sha256,
      },
      recording: {
        filename: recordingPath,
        bytes: recordingSize,
        durationSeconds: 6,
      },
    };
  } finally {
    if (recorder?.exitCode === null) recorder.kill("SIGINT");
    await dashboard?.close().catch(() => undefined);
    await controller?.close().catch(() => undefined);
    await game.close().catch(() => undefined);
    await runtime.close();
  }
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
