import assert from "node:assert/strict";
import test from "node:test";
import { terminalText } from "../dist/terminal.js";

test("terminal text makes browser and caller strings inert and one-line", () => {
  const hostile = [
    "before",
    "\u001b[31mred\u001b[0m",
    "\u001b]8;;https://evil.test\u0007link\u001b]8;;\u0007",
    "line\nforged",
    "\u202Etxt.exe",
    "after"
  ].join(" ");
  const rendered = terminalText(hostile);
  assert.equal(rendered, "before red link line forged txt.exe after");
  assert.doesNotMatch(rendered, /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u);
});

test("terminal text caps human fields without changing machine data", () => {
  const original = "x".repeat(50);
  assert.equal(terminalText(original, 10), "xxxxxxxxx…");
  assert.equal(original.length, 50);
});
