import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CheckpointStore, clearActiveRun, readActiveRun } from "../src/run-checkpoint.js";
import { queueChallenge } from "../src/runner.js";

test("queues a new challenge without attaching it to the launching process", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "runner-queue-"));
  const runDirectory = path.join(root, "runs", "queued");

  try {
    const outcome = await queueChallenge({
      rootDirectory: root,
      output: runDirectory,
      record: false,
    });
    const checkpoint = (await CheckpointStore.load(runDirectory)).snapshot();

    assert.equal(outcome.phase, "waiting_retry");
    assert.equal(outcome.runDirectory, runDirectory);
    assert.equal(checkpoint.pid, null);
    assert.equal(checkpoint.pidStartTicks, null);
    assert.equal(checkpoint.attempt, 0);
    assert.equal(await readActiveRun(root), runDirectory);

    await clearActiveRun(root, runDirectory);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
