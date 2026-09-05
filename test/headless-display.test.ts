import assert from "node:assert/strict";
import test from "node:test";
import { hiddenRecorderArguments } from "../src/headless-display.js";

test("records only the private game and dashboard X displays", () => {
  const args = hiddenRecorderArguments({
    gameDisplay: ":42",
    gameWindowId: 123456,
    dashboardDisplay: ":97",
    output: "/run/challenge.mkv",
  });
  assert.ok(args.includes(":42.0"));
  assert.ok(args.includes(":97.0"));
  assert.ok(args.includes("123456"));
  assert.equal(args.some((argument) => argument.includes("WAYLAND_DISPLAY")), false);
  assert.equal(args.some((argument) => argument.includes("NIRI_SOCKET")), false);
  assert.equal(args.some((argument) => argument.includes("wf-recorder")), false);
  assert.equal(args.at(-1), "/run/challenge.mkv");
});
