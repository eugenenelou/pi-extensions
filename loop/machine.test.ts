import assert from "node:assert/strict";
import { test } from "node:test";
import { type LoopConfig, parseLoopEnv } from "./lib.ts";
import { type HandoffRequest, type LoopHost, LoopMachine } from "./machine.ts";

function config(env: Record<string, string>): LoopConfig {
  const parsed = parseLoopEnv({
    CODASS_LOOP: "heartbeat",
    LOOP_SKILL: "heartbeat",
    HANDOFF_PATH: "/c/loops/heartbeat/handoff.md",
    ...env,
  });
  assert.ok(parsed);
  return parsed;
}

/** A host recording every effect, with the clock, idleness and files in the test. */
function fakeHost(
  opts: { now?: number; idle?: boolean; lastTick?: number | null } = {},
) {
  const state = {
    now: opts.now ?? 1000,
    idle: opts.idle ?? true,
    lastTick: opts.lastTick === undefined ? null : opts.lastTick,
    iterations: 0,
    tokens: null as number | null,
  };
  const sent: string[] = [];
  const handoffs: HandoffRequest[] = [];
  const host: LoopHost = {
    now: () => state.now,
    isIdle: () => state.idle,
    readLastTick: () => state.lastTick,
    stampLastTick: (epoch) => {
      state.lastTick = epoch;
    },
    readIterations: () => state.iterations,
    writeIterations: (count) => {
      state.iterations = count;
    },
    contextTokens: () => state.tokens,
    sendTick: (text) => sent.push(text),
    requestHandoff: (request) => handoffs.push(request),
  };
  return { host, state, sent, handoffs };
}

test("a cadence loop ticks when due and idle, and stamps on send", () => {
  const { host, state, sent } = fakeHost({ now: 1000, lastTick: 1000 });
  const machine = new LoopMachine(config({ LOOP_CADENCE: "60" }), host);
  machine.start();

  state.now = 1030;
  machine.poll();
  assert.deepEqual(sent, []);
  assert.equal(state.lastTick, 1000);

  state.now = 1060;
  machine.poll();
  assert.deepEqual(sent, ["/heartbeat"]);
  assert.equal(state.lastTick, 1060);
});

test("a due tick defers while the agent is busy", () => {
  const { host, state, sent } = fakeHost({ now: 2000, lastTick: 1000 });
  const machine = new LoopMachine(config({ LOOP_CADENCE: "60" }), host);

  state.idle = false;
  machine.poll();
  assert.deepEqual(sent, []);
  assert.equal(state.lastTick, 1000);

  state.idle = true;
  machine.poll();
  assert.deepEqual(sent, ["/heartbeat"]);
});

test("a missing stamp forces a tick", () => {
  const { host, state, sent } = fakeHost({ now: 5000, lastTick: 4999 });
  const machine = new LoopMachine(config({ LOOP_CADENCE: "3600" }), host);

  machine.poll();
  assert.deepEqual(sent, []);

  state.lastTick = null;
  machine.poll();
  assert.deepEqual(sent, ["/heartbeat"]);
  assert.equal(state.lastTick, 5000);
});

test("a cron loop anchors its first fire to the next window, not to now", () => {
  // A Wednesday, 10:00 local; the loop fires Mondays at 08:00.
  const wednesday = new Date(2026, 8, 2, 10, 0, 0).getTime() / 1000;
  const monday = new Date(2026, 8, 7, 8, 0, 0).getTime() / 1000;
  const { host, state, sent } = fakeHost({ now: wednesday });
  const machine = new LoopMachine(config({ LOOP_SCHEDULE: "0 8 * * 1" }), host);

  machine.start();
  assert.equal(state.lastTick, wednesday);

  machine.poll();
  assert.deepEqual(sent, []);

  state.now = monday;
  machine.poll();
  assert.deepEqual(sent, ["/heartbeat"]);
});

test("the run count crosses max_iters into exactly one handoff", () => {
  const { host, state, handoffs } = fakeHost();
  const machine = new LoopMachine(
    config({ LOOP_CADENCE: "60", MAX_ITERS: "3" }),
    host,
  );

  machine.agentEnd();
  machine.agentEnd();
  assert.equal(state.iterations, 2);
  assert.equal(handoffs.length, 0);

  machine.agentEnd();
  assert.equal(handoffs.length, 1);
  assert.equal(handoffs[0].batonPath, "/c/loops/heartbeat/handoff.md");
  assert.match(handoffs[0].focus, /heartbeat/);

  machine.agentEnd();
  assert.equal(handoffs.length, 1);
  assert.equal(state.iterations, 3);
});

test("context past handoff_at hands off, and the successor's count restarts", () => {
  const { host, state, handoffs } = fakeHost();
  const cfg = config({
    LOOP_CADENCE: "60",
    HANDOFF_AT: "1000",
    MAX_ITERS: "99",
  });
  const machine = new LoopMachine(cfg, host);

  state.tokens = 999;
  machine.agentEnd();
  assert.deepEqual(handoffs, []);

  state.tokens = 1000;
  machine.agentEnd();
  assert.equal(handoffs.length, 1);

  // The successor conversation counts against its own counter file.
  const successor = fakeHost();
  successor.state.tokens = 999;
  new LoopMachine(cfg, successor.host).agentEnd();
  assert.equal(successor.state.iterations, 1);
  assert.deepEqual(successor.handoffs, []);
});

test("no tick fires once the handoff is requested", () => {
  const { host, state, sent, handoffs } = fakeHost({ lastTick: null });
  const machine = new LoopMachine(
    config({ LOOP_CADENCE: "60", MAX_ITERS: "1" }),
    host,
  );

  machine.agentEnd();
  assert.equal(handoffs.length, 1);

  machine.poll();
  assert.deepEqual(sent, []);
  assert.equal(state.lastTick, null);
});

test("a handoff that never reached a successor is retried on a later tick", () => {
  const { host, state, sent, handoffs } = fakeHost({ now: 1000, lastTick: null });
  const machine = new LoopMachine(
    config({ LOOP_CADENCE: "60", MAX_ITERS: "1" }),
    host,
  );

  machine.agentEnd();
  assert.equal(handoffs.length, 1);

  // The handoff run failed or was cancelled: no successor session, and nothing
  // outside this session would ever release the loop.
  state.now = 1060;
  machine.poll();
  assert.deepEqual(sent, []);

  state.now = 1000 + 120;
  machine.poll();
  assert.deepEqual(sent, ["/heartbeat"]);

  machine.agentEnd();
  assert.equal(handoffs.length, 2);
});
