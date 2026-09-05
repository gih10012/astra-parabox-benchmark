import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ChallengeState } from "../src/challenge-state.js";
import { ArenaController } from "../src/controller.js";
import { MockGameAdapter } from "../src/game-adapter.js";

test("serves public metrics and protects game controls", async (context) => {
  const webRoot = await mkdtemp(path.join(os.tmpdir(), "arena-web-"));
  await Promise.all([
    writeFile(path.join(webRoot, "index.html"), "ok"),
    writeFile(path.join(webRoot, "app.js"), ""),
    writeFile(path.join(webRoot, "styles.css"), ""),
  ]);
  const state = new ChallengeState();
  const game = new MockGameAdapter();
  const controller = new ArenaController({ state, game, port: 0, webRoot });
  const url = await controller.listen();
  context.after(() => controller.close());
  state.start("test-run");

  assert.equal((await fetch(`${url}/health`)).status, 200);
  const time = await fetch(`${url}/api/challenge/time`).then((response) =>
    response.json(),
  );
  assert.equal(time.status, "running");

  assert.equal(
    (await fetch(`${url}/internal/observe`, { method: "POST" })).status,
    401,
  );
  const headers = {
    Authorization: `Bearer ${controller.controlToken}`,
    "Content-Type": "application/json",
  };
  const frame = await fetch(`${url}/internal/observe`, {
    method: "POST",
    headers,
    body: "{}",
  }).then((response) => response.json());
  assert.equal(frame.mimeType, "image/png");
  assert.ok(frame.data.length > 20);

  const press = await fetch(`${url}/internal/press`, {
    method: "POST",
    headers,
    body: JSON.stringify({ keys: ["UP", "LEFT"], capture: false }),
  }).then((response) => response.json());
  assert.equal(press.pressed, 2);
  assert.deepEqual(game.presses, [["UP", "LEFT"]]);
});
