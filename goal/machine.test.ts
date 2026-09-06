import assert from "node:assert/strict";
import { test } from "node:test";
import type { GoalEntry, Verdict } from "./lib.ts";
import { type GoalHost, GoalMachine } from "./machine.ts";

interface Fake extends GoalHost {
  entries: GoalEntry[];
  sent: string[];
  records: string[];
  notices: { message: string; level: string }[];
  holds: { focus: string; seed: GoalEntry }[];
  releases: number;
  verdict: Verdict | undefined;
  /** Set to hold the judge open, then resolved by the test. */
  pending?: (verdict: Verdict | undefined) => void;
  /** Whether the session ever becomes idle again after a run. */
  idle: boolean;
  clock: number;
}

function fakeHost(verdict?: Verdict): Fake {
  const host: Fake = {
    entries: [],
    sent: [],
    records: [],
    notices: [],
    holds: [],
    releases: 0,
    verdict,
    idle: true,
    clock: 1000,
    now: () => host.clock,
    append: (entry) => host.entries.push(entry),
    send: (text) => host.sent.push(text),
    record: (text) => host.records.push(text),
    notify: (message, level) => host.notices.push({ message, level }),
    conversation: () => "…",
    waitForIdle: () => Promise.resolve(host.idle),
    judge: () =>
      host.pending
        ? new Promise<Verdict | undefined>((resolve) => {
            host.pending = resolve;
          })
        : Promise.resolve(host.verdict),
    hold: (focus, seed) => host.holds.push({ focus, seed }),
    release: () => {
      host.releases += 1;
    },
  };
  return host;
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/** One agent run: its turns, then the run's end — where the judging happens. */
function run(machine: GoalMachine, ...turns: boolean[]): Promise<void> {
  for (const usedTool of turns.length > 0 ? turns : [true]) {
    machine.turnEnd(usedTool);
  }
  return machine.agentEnd();
}

test("setting a goal persists it, holds the handoff and starts a turn", () => {
  const host = fakeHost();
  new GoalMachine(host).set("all tests green");

  assert.deepEqual(host.entries, [{ condition: "all tests green" }]);
  assert.equal(host.sent.length, 1);
  assert.match(host.sent[0], /all tests green/);
  assert.equal(host.holds.length, 1);
  assert.match(host.holds[0].focus, /all tests green/);
  assert.deepEqual(host.holds[0].seed, {
    condition: "all tests green",
    viaHandoff: true,
  });
});

test("not yet: the reason becomes the next turn", async () => {
  const host = fakeHost({ kind: "not-yet", reason: "run the suite" });
  const machine = new GoalMachine(host);
  machine.set("all tests green");
  host.sent.length = 0;

  await run(machine);

  assert.deepEqual(host.sent, ["run the suite"]);
  assert.equal(machine.active(), true);
  assert.equal(machine.status()?.evaluated, 1);
  assert.equal(machine.status()?.lastReason, "run the suite");
});

test("the goal is judged once per run, however many turns it took", async () => {
  const host = fakeHost({ kind: "not-yet", reason: "keep going" });
  const machine = new GoalMachine(host);
  machine.set("all tests green");
  host.sent.length = 0;

  await run(machine, true, true, true);

  assert.deepEqual(host.sent, ["keep going"]);
  assert.equal(machine.status()?.evaluated, 1);
});

test("met: the verdict is recorded and the goal clears", async () => {
  const host = fakeHost({ kind: "met", reason: "the suite is green" });
  const machine = new GoalMachine(host);
  machine.set("all tests green");
  host.sent.length = 0;

  await run(machine);

  assert.equal(host.sent.length, 0);
  assert.equal(host.records.length, 1);
  assert.match(host.records[0], /Goal met: all tests green/);
  assert.deepEqual(host.entries.at(-1), { condition: null });
  assert.equal(host.releases, 1);
  assert.equal(machine.active(), false);
});

test("impossible: the goal clears too", async () => {
  const host = fakeHost({ kind: "impossible", reason: "no such API" });
  const machine = new GoalMachine(host);
  machine.set("call the missing API");

  await run(machine);

  assert.match(host.records[0], /Goal impossible/);
  assert.equal(machine.active(), false);
});

test("an unanswered judge leaves the goal armed and starts no turn", async () => {
  const host = fakeHost(undefined);
  const machine = new GoalMachine(host);
  machine.set("all tests green");
  host.sent.length = 0;

  await run(machine, false);

  assert.deepEqual(host.sent, []);
  assert.equal(machine.active(), true);
  assert.equal(machine.status()?.evaluated, 0);
});

test("a session that never goes idle again is not sent a continuation", async () => {
  const host = fakeHost({ kind: "not-yet", reason: "keep going" });
  const machine = new GoalMachine(host);
  machine.set("all tests green");
  host.sent.length = 0;
  host.idle = false;

  await run(machine);

  assert.deepEqual(host.sent, []);
  assert.equal(machine.active(), true);
});

test("the continuation is sent only once the run that judged it has settled", async () => {
  const host = fakeHost({ kind: "not-yet", reason: "keep going" });
  const machine = new GoalMachine(host);
  machine.set("all tests green");
  host.sent.length = 0;

  let settle = () => {};
  host.waitForIdle = () =>
    new Promise<boolean>((resolve) => {
      settle = () => resolve(true);
    });
  const judged = run(machine);
  await tick();
  assert.deepEqual(host.sent, []);

  settle();
  await judged;
  assert.deepEqual(host.sent, ["keep going"]);
});

test("three tool-less runs stop the loop with the goal kept, until a user message", async () => {
  const host = fakeHost({ kind: "not-yet", reason: "keep going" });
  const machine = new GoalMachine(host);
  machine.set("all tests green");
  host.sent.length = 0;

  await run(machine, false);
  await run(machine, false);
  await run(machine, false);

  assert.deepEqual(host.sent, ["keep going", "keep going"]);
  assert.equal(host.notices.length, 1);
  assert.equal(host.notices[0].level, "warning");
  assert.equal(machine.active(), true);
  assert.equal(machine.status()?.stalled, true);

  await run(machine, false);
  assert.deepEqual(host.sent, ["keep going", "keep going"]);

  machine.userPrompt();
  await run(machine, false);
  assert.deepEqual(host.sent, ["keep going", "keep going", "keep going"]);
});

test("a run with a tool call resets the stall count", async () => {
  const host = fakeHost({ kind: "not-yet", reason: "keep going" });
  const machine = new GoalMachine(host);
  machine.set("all tests green");
  host.sent.length = 0;

  await run(machine, false);
  await run(machine, false);
  // A single tool call, in one turn of a run whose other turns used none.
  await run(machine, false, true, false);
  await run(machine, false);
  await run(machine, false);

  assert.equal(host.notices.length, 0);
  assert.equal(host.sent.length, 5);
});

test("a turn that ends while the judge is out counts for the run it belongs to", async () => {
  const host = fakeHost();
  const machine = new GoalMachine(host);
  machine.set("all tests green");
  host.sent.length = 0;

  host.pending = () => {};
  machine.turnEnd(false);
  const judged = machine.agentEnd();
  // The next run's first turn lands while the judge is still out.
  machine.turnEnd(true);
  host.pending?.({ kind: "not-yet", reason: "keep going" });
  await judged;
  assert.deepEqual(host.sent, ["keep going"]);

  host.pending = undefined;
  host.verdict = { kind: "not-yet", reason: "keep going" };
  await run(machine, false);
  await run(machine, false);

  assert.deepEqual(host.notices, []);
  assert.equal(machine.status()?.stalled, false);
});

test("a resumed session re-arms with a fresh timer and turn count", async () => {
  const host = fakeHost({ kind: "not-yet", reason: "keep going" });
  const machine = new GoalMachine(host);
  host.clock = 5000;

  machine.restore({ condition: "all tests green" });

  assert.deepEqual(host.sent, []);
  assert.deepEqual(host.entries, []);
  assert.equal(host.holds.length, 1);
  assert.equal(machine.status()?.evaluated, 0);
  assert.equal(machine.status()?.elapsedSeconds, 0);
});

test("a goal seeded by a handoff is re-armed and consumed in the successor", () => {
  const host = fakeHost();
  const machine = new GoalMachine(host);

  machine.restore({ condition: "all tests green", viaHandoff: true });

  assert.equal(machine.active(), true);
  // The handoff itself sends the resume directive, once the baton is in place.
  assert.deepEqual(host.sent, []);
  // Consumed: a later resume of this conversation must not seed a turn again.
  assert.deepEqual(host.entries, [{ condition: "all tests green" }]);
});

test("clearing drops the goal and releases the handoff hold", () => {
  const host = fakeHost();
  const machine = new GoalMachine(host);
  machine.set("all tests green");

  assert.equal(machine.clear(), "all tests green");
  assert.equal(host.releases, 1);
  assert.deepEqual(host.entries.at(-1), { condition: null });
  assert.equal(machine.clear(), undefined);
  assert.equal(machine.status(), undefined);
});

test("a goal-less session releases the hold a previous one left behind", () => {
  const host = fakeHost();
  new GoalMachine(host).set("all tests green");

  // The next session in this process: no goal in it, and nothing to persist.
  new GoalMachine(host).releaseHold();

  assert.equal(host.releases, 1);
  assert.deepEqual(host.entries, [{ condition: "all tests green" }]);
});

test("a session with a goal releases its hold on shutdown", () => {
  const host = fakeHost();
  const machine = new GoalMachine(host);
  machine.set("all tests green");

  machine.releaseHold();

  assert.equal(host.releases, 1);
  // The goal itself survives: the session file still carries it.
  assert.deepEqual(host.entries, [{ condition: "all tests green" }]);
});
