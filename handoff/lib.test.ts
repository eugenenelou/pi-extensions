import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildAttachment,
  handoffPathFor,
  promptFromFile,
  resolvePromptFile,
  restoreEditorText,
  widgetLines,
} from "./lib.ts";

test("handoff file sits beside the transcript with the same stem", () => {
  assert.equal(
    handoffPathFor("/s/dir/2026-09-05T12-41-11-737Z_abc.jsonl", "/s/dir", "abc"),
    "/s/dir/2026-09-05T12-41-11-737Z_abc.handoff.md",
  );
});

test("ephemeral session falls back to the session id in the session dir", () => {
  assert.equal(handoffPathFor(undefined, "/s/dir", "abc"), "/s/dir/abc.handoff.md");
});

test("restore puts stashed inputs before the current editor text", () => {
  assert.equal(restoreEditorText(["a", "b"], "c"), "a\n\nb\n\nc");
  assert.equal(restoreEditorText(["a"], "  "), "a");
});

test("attachment carries the handoff and names no file", () => {
  const text = buildAttachment("## Goal\nship\n");
  assert.doesNotMatch(text, /\.md|\//);
  assert.match(text, /complete handoff/);
  assert.ok(text.endsWith("## Goal\nship"));
});

test("widget lists one line per stashed input plus the hint", () => {
  const lines = widgetLines(["/skill:implement X", "then test"], "armed");
  assert.equal(lines.length, 4);
  assert.equal(lines[1], "Handoff → /skill:implement X");
  assert.match(widgetLines([], "writing")[0], /writing/);
});

test("prompt file drops frontmatter and keeps the extension's contract", () => {
  const out = promptFromFile("---\nname: x\n---\n# Rules\nbe brief\n");
  assert.ok(out.startsWith("# Rules\nbe brief"));
  assert.ok(out.includes("output the handoff markdown only"));
  assert.equal(promptFromFile("no frontmatter").startsWith("no frontmatter"), true);
});

test("promptFile resolves ~ and relative paths", () => {
  assert.equal(resolvePromptFile("~/a.md", "/cwd", "/home/u"), "/home/u/a.md");
  assert.equal(resolvePromptFile("x/a.md", "/cwd", "/home/u"), "/cwd/x/a.md");
  assert.equal(resolvePromptFile("/abs.md", "/cwd", "/home/u"), "/abs.md");
});
