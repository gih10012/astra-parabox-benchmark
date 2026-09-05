#!/usr/bin/env node
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ChallengeState } from "./challenge-state.js";
import { ArenaController } from "./controller.js";
import { runDoctor } from "./doctor.js";
import { MockGameAdapter } from "./game-adapter.js";
import { runModelSmoke } from "./model-smoke.js";
import { restoreFromRecovery } from "./save-guard.js";
import { runChallenge } from "./runner.js";
import { TARGET_LEVELS } from "./types.js";

const sourceDirectory = path.dirname(fileURLToPath(import.meta.url));
const rootDirectory = path.resolve(
  sourceDirectory,
  import.meta.url.includes("/dist/") ? "../.." : "..",
);
const [command = "help", ...args] = process.argv.slice(2);

if (command === "doctor") {
  const checks = await runDoctor();
  if (args.includes("--json")) console.log(JSON.stringify(checks, null, 2));
  else {
    for (const check of checks) {
      const mark = check.ok ? "✓" : check.required ? "✗" : "!";
      console.log(`${mark} ${check.name.padEnd(34)} ${check.detail}`);
    }
  }
  if (checks.some((check) => check.required && !check.ok)) process.exitCode = 1;
} else if (command === "demo") {
  const port = numberArg(args, "--port", 4317);
  const duration = numberArg(args, "--duration", 0);
  const state = new ChallengeState("gpt-6-astra", TARGET_LEVELS);
  const demoControlToken = process.env.ARENA_DEMO_CONTROL_TOKEN;
  const controller = new ArenaController({
    state,
    game: new MockGameAdapter(),
    port,
    webRoot: path.join(rootDirectory, "web"),
    ...(demoControlToken ? { controlToken: demoControlToken } : {}),
  });
  const url = await controller.listen();
  state.start("demo-00000000");
  state.ingestSave(mockSave(TARGET_LEVELS, 87));
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
  controller.publishTranscript({
    type: "turn.started",
  });
  controller.publishTranscript({
    type: "item.completed",
    item: {
      type: "reasoning",
      text: "Inspecting the recursive box structure and planning the next sequence.",
    },
  });
  controller.publishTranscript({
    type: "item.completed",
    item: {
      type: "mcp_tool_call",
      server: "parabox",
      tool: "observe_game",
      arguments: {},
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
  console.log(`Director dashboard: ${url}`);
  if (!args.includes("--no-browser")) {
    spawn("google-chrome-stable", [`--app=${url}`], {
      detached: true,
      stdio: "ignore",
    }).unref();
  }
  if (duration > 0) {
    await new Promise((resolve) => setTimeout(resolve, duration * 1_000));
    await controller.close();
  } else {
    await new Promise<void>((resolve) => {
      process.once("SIGINT", resolve);
      process.once("SIGTERM", resolve);
    });
    await controller.close();
  }
} else if (command === "run") {
  const outputIndex = args.indexOf("--output");
  const outputValue = outputIndex >= 0 ? args[outputIndex + 1] : undefined;
  const reasoning = stringArg(args, "--reasoning", "high") as
    | "low"
    | "medium"
    | "high"
    | "xhigh"
    | "max";
  if (!["low", "medium", "high", "xhigh", "max"].includes(reasoning)) {
    throw new Error("--reasoning must be low, medium, high, xhigh, or max");
  }
  const directory = await runChallenge({
    rootDirectory,
    port: numberArg(args, "--port", 4317),
    reasoningEffort: reasoning,
    record: !args.includes("--no-record"),
    openDashboard: !args.includes("--no-browser"),
    isolateSaves: !args.includes("--keep-saves"),
    ...(outputValue
      ? { output: path.resolve(outputValue) }
      : {}),
  });
  console.log(`Run artifacts: ${directory}`);
} else if (command === "smoke-model") {
  const result = await runModelSmoke(rootDirectory);
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
} else if (command === "restore") {
  const recovery = args[0];
  if (!recovery) throw new Error("Usage: parabox-arena restore <save-recovery.json>");
  await restoreFromRecovery(path.resolve(recovery));
  console.log("Save files restored.");
} else {
  console.log(`Astra × Parabox Arena

Usage:
  parabox-arena doctor [--json]
  parabox-arena demo [--port 4317] [--duration SECONDS] [--no-browser]
  parabox-arena smoke-model
  parabox-arena run [--reasoning high] [--no-record] [--no-browser] [--keep-saves]
  parabox-arena restore <run/save-recovery.json>
`);
}

function numberArg(args: string[], name: string, fallback: number): number {
  const index = args.indexOf(name);
  if (index < 0 || !args[index + 1]) return fallback;
  const value = Number(args[index + 1]);
  if (!Number.isFinite(value)) throw new Error(`${name} must be a number`);
  return value;
}

function stringArg(args: string[], name: string, fallback: string): string {
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1] : undefined;
  return value ?? fallback;
}

function mockSave(total: number, completed: number): string {
  const lines = Array.from({ length: total }, (_, index) =>
    `level_${index} ${index < completed ? 1 : 0} ${index < completed ? 1 : 0}`,
  );
  return `version 6\n-section levels\n${lines.join("\n")}\n`;
}
