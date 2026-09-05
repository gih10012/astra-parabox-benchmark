import assert from "node:assert/strict";
import test from "node:test";
import { parseParaboxSave } from "../src/save-parser.js";

test("parses only the levels section with LF or CRLF", () => {
  const text = [
    "version 6",
    "-section levels",
    "alpha 1 1",
    "beta 1 0",
    "gamma 0 0",
    "-section other",
    "not_a_level 1 1",
    "",
  ].join("\r\n");
  assert.deepEqual(parseParaboxSave(text), {
    total: 3,
    unlocked: 2,
    completed: 1,
  });
});

test("ignores malformed level rows", () => {
  assert.deepEqual(
    parseParaboxSave("-section levels\nmissing\nwide 1 1 extra\ngood 0 1\n"),
    { total: 1, unlocked: 0, completed: 1 },
  );
});
