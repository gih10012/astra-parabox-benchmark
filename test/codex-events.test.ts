import assert from "node:assert/strict";
import test from "node:test";
import { publicTranscriptEvent } from "../src/codex-events.js";

test("retains complete Codex events while removing secrets and image payloads", () => {
  const visible = publicTranscriptEvent({
    type: "item.completed",
    item: {
      id: "tool-1",
      type: "mcp_tool_call",
      server: "parabox",
      tool: "observe_game",
      arguments: { note: "keep me" },
      result: {
        data: "A".repeat(2_000),
        sha256: "abc123",
      },
      control_token: "do-not-show",
      status: "completed",
    },
  }) as Record<string, unknown>;
  const item = visible.item as Record<string, unknown>;
  const result = item.result as Record<string, unknown>;

  assert.equal(item.id, "tool-1");
  assert.deepEqual(item.arguments, { note: "keep me" });
  assert.equal(result.sha256, "abc123");
  assert.match(String(result.data), /binary payload omitted/);
  assert.equal(item.control_token, "[REDACTED]");
});

test("passes through stderr and command output for the director transcript", () => {
  assert.deepEqual(
    publicTranscriptEvent({ type: "stderr", message: "request timed out" }),
    { type: "stderr", message: "request timed out" },
  );
  assert.deepEqual(
    publicTranscriptEvent({
      type: "item.completed",
      item: {
        id: "cmd-1",
        type: "command_execution",
        command: "pwd",
        aggregated_output: "/workspace\n",
        exit_code: 0,
        status: "completed",
      },
    }),
    {
      type: "item.completed",
      item: {
        id: "cmd-1",
        type: "command_execution",
        command: "pwd",
        aggregated_output: "/workspace\n",
        exit_code: 0,
        status: "completed",
      },
    },
  );
});
