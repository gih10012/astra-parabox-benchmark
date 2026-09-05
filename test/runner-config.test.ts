import assert from "node:assert/strict";
import test from "node:test";
import { codexEnvironment } from "../src/codex-home.js";
import { codexArguments, NEUTRAL_PROMPT } from "../src/runner.js";

test("disables search and browsers while retaining normal Codex capabilities", () => {
  const args = codexArguments({
    mcpEntry: "/arena/mcp.js",
    arenaUrl: "http://127.0.0.1:4317",
    controlToken: "secret",
    reasoningEffort: "high",
  });
  assert.ok(args.includes('web_search="disabled"'));
  assert.ok(args.includes("tools.web_search=false"));
  assert.ok(args.includes("features.browser_use=false"));
  assert.ok(args.includes("features.browser_use_external=false"));
  assert.ok(args.includes("features.in_app_browser=false"));
  assert.ok(args.includes("sandbox_workspace_write.network_access=false"));
  assert.equal(args.includes("--ignore-user-config"), false);
  assert.equal(args.includes("features.shell_tool=false"), false);
  assert.equal(args.includes("features.multi_agent=false"), false);
  assert.equal(args.includes("features.apps=false"), false);
  assert.equal(args.includes("features.remote_plugin=false"), false);
  assert.equal(args.includes("features.memories=false"), false);
  assert.equal(args[args.indexOf("--sandbox") + 1], "workspace-write");
  assert.equal(args.at(-1), NEUTRAL_PROMPT);
  const allowlist = args.find((argument) =>
    argument.startsWith("mcp_servers.parabox.enabled_tools="),
  );
  assert.equal(
    allowlist,
    'mcp_servers.parabox.enabled_tools=["observe_game","press_keys","challenge_time","challenge_tokens"]',
  );
  assert.ok(
    args.includes('mcp_servers.parabox.default_tools_approval_mode="approve"'),
  );
  assert.equal(args.some((argument) => argument.includes("view_image")), false);
});

test("passes the selected credential home through the local Codex launcher", () => {
  const env = codexEnvironment("/credentials/codex");
  assert.equal(env.CODEX_HOME, "/credentials/codex");
  assert.equal(env.CODEX_HOME_OVERRIDE, "/credentials/codex");
});
