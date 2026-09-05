import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { restoreFromRecovery, SaveGuard } from "../src/save-guard.js";

test("archives challenge saves and restores original saves", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "save-guard-"));
  const saves = path.join(root, "saves");
  const run = path.join(root, "run");
  await (await import("node:fs/promises")).mkdir(saves, { recursive: true });
  await writeFile(path.join(saves, "save0.txt"), "original");
  const guard = new SaveGuard(saves, run);

  await guard.prepare();
  assert.deepEqual(await readdir(saves), []);
  await writeFile(path.join(saves, "save0.txt"), "challenge");
  await guard.restore();

  assert.equal(await readFile(path.join(saves, "save0.txt"), "utf8"), "original");
  assert.equal(
    await readFile(path.join(run, "challenge-save/save0.txt"), "utf8"),
    "challenge",
  );
  const recovery = JSON.parse(await readFile(guard.recoveryPath, "utf8"));
  assert.ok(recovery.restoredAt);
});

test("restores a checkpointed challenge after a completed restore cycle", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "save-resume-"));
  const saves = path.join(root, "saves");
  const run = path.join(root, "run");
  await (await import("node:fs/promises")).mkdir(saves, { recursive: true });
  await writeFile(path.join(saves, "save0.txt"), "original");
  const guard = new SaveGuard(saves, run);
  await guard.prepare();
  await writeFile(path.join(saves, "save0.txt"), "challenge");
  await guard.restore();

  const resumed = new SaveGuard(saves, run);
  await resumed.resume();
  assert.equal(await readFile(path.join(saves, "save0.txt"), "utf8"), "challenge");
});

test("manual crash recovery archives the live challenge before restoring originals", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "save-recovery-"));
  const saves = path.join(root, "saves");
  const run = path.join(root, "run");
  await (await import("node:fs/promises")).mkdir(saves, { recursive: true });
  await writeFile(path.join(saves, "save0.txt"), "original");
  const guard = new SaveGuard(saves, run);
  await guard.prepare();
  await writeFile(path.join(saves, "save0.txt"), "challenge-after-crash");

  await restoreFromRecovery(guard.recoveryPath);
  assert.equal(await readFile(path.join(saves, "save0.txt"), "utf8"), "original");
  assert.equal(
    await readFile(path.join(run, "challenge-save/save0.txt"), "utf8"),
    "challenge-after-crash",
  );
});
