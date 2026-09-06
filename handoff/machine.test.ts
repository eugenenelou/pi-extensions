import assert from "node:assert/strict";
import { test } from "node:test";
import { HandoffMachine, type Host, type NextSession } from "./machine.ts";

/** A host whose async steps are resolved by the test, recording every effect. */
function fakeHost(opts: { idle?: boolean; conversation?: string } = {}) {
  const log: string[] = [];
  let idle = opts.idle ?? true;
  let resolveIdle = () => {};
  let resolveComplete: (text: string | null) => void = () => {};
  let rejectComplete: (err: Error) => void = () => {};
  let signal: AbortSignal | undefined;
  let editor = "";
  let widget: string[] | undefined;
  let newSessionCancelled = false;
  let shutdownDuringSwitch: (() => void) | undefined;
  const next: NextSession & { sent: string[]; appended: string[] } = {
    sent: [],
    appended: [],
    appendMessage: (t) => {
      next.appended.push(t);
      log.push("append");
    },
    clearWidget: () => {
      widget = undefined;
    },
    sendUserMessage: async (t) => {
      next.sent.push(t);
      log.push(`send:${t}`);
    },
    notify: (m) => log.push(`next.notify:${m}`),
  };
  const host: Host = {
    isIdle: () => idle,
    waitForIdle: () => new Promise<void>((r) => (resolveIdle = r)),
    notify: (m) => log.push(`notify:${m}`),
    setWidget: (lines) => {
      widget = lines;
    },
    getEditorText: () => editor,
    setEditorText: (t) => {
      editor = t;
    },
    conversation: () => opts.conversation ?? "user: hi",
    systemPrompt: () => "PROMPT",
    complete: (_p, _i, s) =>
      new Promise((res, rej) => {
        signal = s;
        resolveComplete = res;
        rejectComplete = rej;
      }),
    handoffPath: () => "/s/x.handoff.md",
    writeFile: (p, t) => log.push(`write:${p}:${t}`),
    newSession: async (withSession) => {
      log.push("newSession");
      shutdownDuringSwitch?.();
      if (newSessionCancelled) return { cancelled: true };
      await withSession(next);
      return { cancelled: false };
    },
  };
  return {
    host,
    next,
    log,
    settle: () => {
      idle = true;
      resolveIdle();
    },
    finishHandoff: (text: string | null = "## Next\ngo") =>
      resolveComplete(text),
    failHandoff: (err: Error) => rejectComplete(err),
    get signal() {
      return signal;
    },
    get editor() {
      return editor;
    },
    set editor(t: string) {
      editor = t;
    },
    get widget() {
      return widget;
    },
    cancelNewSession: () => {
      newSessionCancelled = true;
    },
    onShutdownDuringSwitch: (fn: () => void) => {
      shutdownDuringSwitch = fn;
    },
  };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

test("idle: writes the file, attaches the handoff first, replays captured inputs in order", async () => {
  const f = fakeHost();
  const m = new HandoffMachine();
  const done = m.command(f.host, "focus");
  assert.equal(m.phase, "writing");
  assert.equal(m.onInput("first", undefined), true);
  assert.equal(m.onInput("/skill:implement X", undefined), true);
  assert.deepEqual(f.widget?.slice(1, 3), [
    "Handoff → first",
    "Handoff → /skill:implement X",
  ]);
  f.finishHandoff("## Goal\nship\n");
  await done;
  await tick();
  assert.equal(
    f.log.find((l) => l.startsWith("write:")),
    "write:/s/x.handoff.md:## Goal\nship\n",
  );
  assert.match(f.next.appended[0], /^Handoff from the previous session/);
  assert.deepEqual(f.next.sent, ["first", "/skill:implement X"]);
  assert.ok(f.log.indexOf("append") < f.log.indexOf("send:first"));
  assert.equal(m.phase, "idle");
  assert.equal(f.widget, undefined);
});

test("the switch's own session_shutdown must not drop the stash", async () => {
  const f = fakeHost();
  const m = new HandoffMachine();
  f.onShutdownDuringSwitch(() => m.onSessionShutdown());
  const done = m.command(f.host, "");
  m.onInput("keep me", undefined);
  f.finishHandoff();
  await done;
  await tick();
  assert.deepEqual(f.next.sent, ["keep me"]);
});

test("input typed while switching is still captured and replayed", async () => {
  const f = fakeHost();
  const m = new HandoffMachine();
  f.onShutdownDuringSwitch(() => {
    assert.equal(m.phase, "switching");
    assert.equal(m.onInput("late", undefined), true);
  });
  const done = m.command(f.host, "");
  f.finishHandoff();
  await done;
  await tick();
  assert.deepEqual(f.next.sent, ["late"]);
});

test("armed: only follow-ups are captured until the agent settles", async () => {
  const f = fakeHost({ idle: false });
  const m = new HandoffMachine();
  const done = m.command(f.host, "");
  assert.equal(m.phase, "armed");
  assert.equal(m.onInput("steer the agent", "steer"), false);
  assert.equal(m.onInput("for the new session", "followUp"), true);
  f.settle();
  await tick();
  assert.equal(m.phase, "writing");
  f.finishHandoff();
  await done;
  await tick();
  assert.deepEqual(f.next.sent, ["for the new session"]);
});

test("/handoff again while writing aborts and restores inputs ahead of the editor text", async () => {
  const f = fakeHost();
  const m = new HandoffMachine();
  const done = m.command(f.host, "");
  m.onInput("a", undefined);
  m.onInput("b", undefined);
  f.editor = "typing";
  await m.command(f.host, "");
  assert.equal(f.signal?.aborted, true);
  assert.equal(f.editor, "a\n\nb\n\ntyping");
  assert.equal(m.phase, "idle");
  assert.equal(f.widget, undefined);
  f.finishHandoff(null);
  await done;
  assert.equal(f.log.filter((l) => l === "newSession").length, 0);
});

test("generation failure cancels with the error and restores inputs", async () => {
  const f = fakeHost();
  const m = new HandoffMachine();
  const done = m.command(f.host, "");
  m.onInput("a", undefined);
  f.failHandoff(new Error("boom"));
  await done;
  assert.ok(f.log.some((l) => l === "notify:Handoff generation failed: boom"));
  assert.equal(f.editor, "a");
  assert.equal(m.phase, "idle");
});

test("empty conversation cancels before calling the model", async () => {
  const f = fakeHost({ conversation: undefined as unknown as string });
  f.host.conversation = () => undefined;
  const m = new HandoffMachine();
  await m.command(f.host, "");
  assert.ok(f.log.includes("notify:No conversation to hand off"));
  assert.equal(f.signal, undefined);
});

test("cancelled new session restores inputs", async () => {
  const f = fakeHost();
  f.cancelNewSession();
  const m = new HandoffMachine();
  const done = m.command(f.host, "");
  m.onInput("a", undefined);
  f.finishHandoff();
  await done;
  assert.equal(f.editor, "a");
  assert.equal(m.phase, "idle");
});
