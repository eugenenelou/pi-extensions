import assert from "node:assert/strict";
import { test } from "node:test";
import {
  goalFromEntries,
  goalIndicator,
  parseGoalCommand,
  parseVerdict,
  statusText,
} from "./lib.ts";

test("parses the command forms", () => {
  assert.deepEqual(parseGoalCommand("  "), { kind: "status" });
  assert.deepEqual(parseGoalCommand(" clear "), { kind: "clear" });
  assert.deepEqual(parseGoalCommand("all tests green"), {
    kind: "set",
    condition: "all tests green",
  });
});

test("the last goal entry wins, and a cleared one leaves no goal", () => {
  const entries = [
    { type: "custom", customType: "goal", data: { condition: "first" } },
    { type: "message" },
    { type: "custom", customType: "goal", data: { condition: "second" } },
  ];
  assert.deepEqual(goalFromEntries(entries), { condition: "second" });
  assert.equal(
    goalFromEntries([
      ...entries,
      { type: "custom", customType: "goal", data: { condition: null } },
    ]),
    undefined,
  );
  assert.equal(goalFromEntries([{ type: "message" }]), undefined);
});

test("a handoff-seeded entry is recognised as one", () => {
  assert.deepEqual(
    goalFromEntries([
      {
        type: "custom",
        customType: "goal",
        data: { condition: "ship it", viaHandoff: true },
      },
    ]),
    { condition: "ship it", viaHandoff: true },
  );
});

test("reads the judge's verdict and reason", () => {
  assert.deepEqual(parseVerdict("VERDICT: met\nREASON: the suite is green."), {
    kind: "met",
    reason: "the suite is green.",
  });
  assert.deepEqual(parseVerdict("verdict: not yet\nreason: run the tests."), {
    kind: "not-yet",
    reason: "run the tests.",
  });
  assert.equal(
    parseVerdict("VERDICT: impossible\nREASON: no such API.")?.kind,
    "impossible",
  );
  assert.equal(parseVerdict("I could not decide."), undefined);
});

test("status reports the condition, elapsed time, turns and last reason", () => {
  const text = statusText({
    condition: "all tests green",
    elapsedSeconds: 3720,
    evaluated: 4,
    lastReason: "two failures left",
    stalled: false,
  });
  assert.match(text, /all tests green/);
  assert.match(text, /1h02 elapsed/);
  assert.match(text, /4 turn\(s\) evaluated/);
  assert.match(text, /two failures left/);
  assert.match(statusText(undefined), /No goal set/);
});

test("the footer marker shortens a long condition", () => {
  assert.equal(goalIndicator("ship", 32), "goal: ship");
  assert.equal(goalIndicator("x".repeat(40), 10), `goal: ${"x".repeat(9)}…`);
});
