import assert from "node:assert/strict";
import test from "node:test";
import { hiddenRecorderArguments } from "../src/headless-display.js";

test("records only the private game and dashboard X displays", () => {
  const args = hiddenRecorderArguments({
    gameDisplay: ":42",
    dashboardDisplay: ":97",
    output: "/run/challenge.mkv",
  });
  assert.ok(args.includes(":42.0"));
  assert.ok(args.includes(":97.0"));
  assert.equal(args.includes("-window_id"), false);
  assert.ok(args.includes("1280x1080"));
  assert.equal(args.some((argument) => argument.includes("WAYLAND_DISPLAY")), false);
  assert.equal(args.some((argument) => argument.includes("NIRI_SOCKET")), false);
  assert.equal(args.some((argument) => argument.includes("wf-recorder")), false);
  const filter = args[args.indexOf("-filter_complex") + 1] ?? "";
  assert.ok(filter.startsWith("[0:v]crop=1272:1072:8:8"));
  assert.equal(filter.match(/setpts=N\/\(30\*TB\)/g)?.length, 3);
  assert.ok(filter.indexOf("setpts=N/(30*TB)[g]") < filter.indexOf("hstack"));
  assert.ok(args.some((argument) => argument.includes("fps=30")));
  assert.ok(args.includes("cfr"));
  assert.equal(args.at(-1), "/run/challenge.mkv");
});
