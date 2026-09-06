/**
 * Probe for the bash output cap:
 *   node --experimental-strip-types sandbox/bash-output.test.ts
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OUTPUT_CAP, capBashOutput } from "./bash-output.ts";

const HEAD = OUTPUT_CAP.headLines;
const TAIL = OUTPUT_CAP.tailLines;

function numbered(count: number): string {
  return Array.from({ length: count }, (_, i) => `line ${i + 1}`).join("\n");
}

function neverWrites(): string {
  throw new Error("should not have written a file");
}

const dir = mkdtempSync(join(tmpdir(), "bash-output-test-"));

function savedFile(name: string, content: string): string {
  const path = join(dir, name);
  writeFileSync(path, content, "utf-8");
  return path;
}

// Exactly at the cap: nothing to elide, the result is left alone.
assert.equal(
  capBashOutput(numbered(HEAD + TAIL), { writeFullOutput: neverWrites }),
  undefined,
);

// A trailing newline is not an extra line.
assert.equal(
  capBashOutput(`${numbered(HEAD + TAIL)}\n`, { writeFullOutput: neverWrites }),
  undefined,
);

// Above the cap: head, marker, tail — and the marker's file holds everything.
const LONG = numbered(500);
let written: string | undefined;
const capped = capBashOutput(LONG, {
  writeFullOutput: (content) => {
    written = content;
    return "/tmp/full-output.txt";
  },
});
assert.ok(capped);
const lines = capped.split("\n");
assert.equal(lines.length, HEAD + 1 + TAIL);
assert.deepEqual(lines.slice(0, HEAD), numbered(HEAD).split("\n"));
assert.deepEqual(lines.slice(HEAD + 1), LONG.split("\n").slice(-TAIL));
assert.match(lines[HEAD], /\/tmp\/full-output\.txt/);
assert.match(lines[HEAD], /\b500\b/);
assert.equal(written, LONG);

// pi truncated already: it kept the LAST lines, so the head we show comes from
// its file, its totals are reported, and its marker does not reach the tail.
const piWindow = Array.from({ length: 300 }, (_, i) => `line ${4701 + i}`).join(
  "\n",
);
const piPath = savedFile("pi-full.txt", numbered(5000));
const piText = `${piWindow}\n\n[Showing lines 4701-5000 of 5000. Full output: ${piPath}]`;
const cappedPi = capBashOutput(piText, {
  fullOutputPath: piPath,
  totalLines: 5000,
  writeFullOutput: neverWrites,
});
assert.ok(cappedPi);
const piLines = cappedPi.split("\n");
assert.equal(piLines.length, HEAD + 1 + TAIL);
assert.deepEqual(piLines.slice(0, HEAD), numbered(HEAD).split("\n"));
assert.match(piLines[HEAD], /\b5000\b/);
assert.match(piLines[HEAD], new RegExp(piPath));
assert.equal(piLines.at(-1), "line 5000");

// A failing command: pi throws, so the result carries no details — path and
// total come from the marker itself, nothing is written, and the status stays.
const failPath = savedFile("fail-full.txt", numbered(5000));
const failText =
  `${piWindow}\n\n[Showing lines 4701-5000 of 5000. Full output: ${failPath}]` +
  "\n\nCommand exited with code 1";
const cappedFail = capBashOutput(failText, { writeFullOutput: neverWrites });
assert.ok(cappedFail);
const failLines = cappedFail.split("\n");
assert.deepEqual(failLines.slice(0, HEAD), numbered(HEAD).split("\n"));
assert.match(failLines[HEAD], new RegExp(failPath));
assert.match(failLines[HEAD], /\b5000\b/);
assert.equal(failLines.at(-1), "Command exited with code 1");

// A line of the command's own output that merely starts with "[Showing " is
// not pi's marker and stays put.
const inner = LONG.split("\n");
inner[4] = "[Showing my own bracket line]";
const cappedInner = capBashOutput(inner.join("\n"), {
  writeFullOutput: () => "/tmp/inner.txt",
});
assert.ok(cappedInner);
assert.equal(cappedInner.split("\n")[4], "[Showing my own bracket line]");

// The marker's path really points at the complete output when we wrote it.
const realCapped = capBashOutput(LONG, {});
assert.ok(realCapped);
const path = /Full output: (\S+)\]/.exec(realCapped.split("\n")[HEAD])?.[1];
assert.ok(path);
assert.equal(readFileSync(path, "utf-8"), LONG);

console.log("sandbox bash output cap: ok");
