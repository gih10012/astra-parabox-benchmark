import assert from "node:assert/strict";
import test from "node:test";
import { codexArguments, NEUTRAL_PROMPT } from "../src/runner.js";

test("builds a strict Codex invocation with only the arena MCP allowlist", () => {
  const args = codexArguments({
    mcpEntry: "/arena/mcp.js",
    arenaUrl: "http://127.0.0.1:4317",
    controlToken: "secret",
    reasoningEffort: "high",
    providerAssignments: [
      { key: "model_provider", tomlValue: '"proxy"' },
    ],
  });
  assert.ok(args.includes("--strict-config"));
  assert.ok(args.includes("--ignore-user-config"));
  assert.ok(args.includes('web_search="disabled"'));
  assert.ok(args.includes("features.shell_tool=false"));
  assert.ok(args.includes("features.multi_agent=false"));
  assert.ok(args.includes('model_provider="proxy"'));
  assert.equal(args.at(-1), NEUTRAL_PROMPT);
  const allowlist = args.find((argument) =>
    argument.startsWith("mcp_servers.parabox.enabled_tools="),
  );
  assert.equal(
    allowlist,
    'mcp_servers.parabox.enabled_tools=["observe_game","press_keys","challenge_time","challenge_tokens"]',
  );
  assert.equal(args.some((argument) => argument.includes("view_image")), false);
});
