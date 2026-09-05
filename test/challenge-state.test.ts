import assert from "node:assert/strict";
import test from "node:test";
import { ChallengeState } from "../src/challenge-state.js";

function save(total: number, completed: number): string {
  const rows = Array.from(
    { length: total },
    (_, index) => `level_${index} 1 ${index < completed ? 1 : 0}`,
  );
  return `-section levels\n${rows.join("\n")}\n`;
}

test("uses monotonic time and completes only at the exact target catalog", () => {
  const state = new ChallengeState("gpt-6-astra", 3);
  state.start("run", 1_000, 5_000_000_000n);
  assert.equal(state.timeSnapshot(2_000, 5_250_000_000n).elapsedMs, 250);
  state.ingestSave(save(2, 2));
  assert.equal(state.snapshot().status, "running");
  state.ingestSave(save(3, 3));
  assert.equal(state.snapshot().status, "completed");
  assert.equal(state.snapshot().progress.completed, 3);
});

test("tracks the largest cumulative token sample across event formats", () => {
  const state = new ChallengeState();
  state.ingestCodexEvent({
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: {
          input_tokens: 100,
          cached_input_tokens: 40,
          output_tokens: 20,
          reasoning_output_tokens: 8,
          total_tokens: 120,
        },
      },
    },
  });
  state.ingestCodexEvent({
    type: "turn.completed",
    usage: {
      input_tokens: 50,
      cached_input_tokens: 10,
      output_tokens: 10,
      reasoning_output_tokens: 2,
    },
  });
  assert.deepEqual(state.tokenSnapshot(), {
    inputTokens: 100,
    cachedInputTokens: 40,
    outputTokens: 20,
    reasoningOutputTokens: 8,
    totalTokens: 120,
    source: "rollout",
    sampledAt: state.tokenSnapshot().sampledAt,
  });
});
