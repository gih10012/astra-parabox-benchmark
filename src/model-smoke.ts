import { spawn } from "node:child_process";
import { once } from "node:events";
import os from "node:os";
import path from "node:path";
import { ChallengeState } from "./challenge-state.js";
import { ArenaController } from "./controller.js";
import { MockGameAdapter } from "./game-adapter.js";
import { loadProviderConfig } from "./provider-config.js";
import { codexArguments } from "./runner.js";

export async function runModelSmoke(rootDirectory: string): Promise<{
  ok: boolean;
  code: number | null;
  calledChallengeTime: boolean;
  output: string;
}> {
  const state = new ChallengeState();
  const controller = new ArenaController({
    state,
    game: new MockGameAdapter(),
    port: 0,
    webRoot: path.join(rootDirectory, "web"),
  });
  const url = await controller.listen();
  state.start("model-smoke");
  const provider = await loadProviderConfig();
  const args = codexArguments({
    mcpEntry: path.join(rootDirectory, "dist/src/mcp.js"),
    arenaUrl: url,
    controlToken: controller.controlToken,
    reasoningEffort: "low",
    providerAssignments: provider?.assignments ?? [],
    prompt:
      "Call challenge_time exactly once, then reply only with the returned elapsedMs integer.",
  });
  const child = spawn("codex", args, {
    cwd: os.tmpdir(),
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    output += chunk.toString("utf8");
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    output += chunk.toString("utf8");
  });
  const timeout = setTimeout(() => child.kill("SIGINT"), 120_000);
  const [code] = (await once(child, "exit")) as [number | null, string | null];
  clearTimeout(timeout);
  await controller.close();
  const calledChallengeTime =
    output.includes('"tool":"challenge_time"') ||
    output.includes('"name":"challenge_time"');
  return {
    ok: code === 0 && calledChallengeTime,
    code,
    calledChallengeTime,
    output: output.slice(-4_000),
  };
}
