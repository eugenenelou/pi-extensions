import assert from "node:assert/strict";
import { test } from "node:test";
import {
  HandoffMachine,
  headlessHost,
  type Host,
  type NextSession,
} from "./machine.ts";

/** A host whose async steps are resolved by the test, recording every effect. */
function fakeHost(
  opts: { idle?: boolean; conversation?: string; resume?: string } = {},
) {
  const log: string[] = [];
  let idle = opts.idle ?? true;
  let resolveIdle = () => {};
  let resolveComplete: (text: string | null) => void = () => {};
  let rejectComplete: (err: Error) => void = () => {};
  let signal: AbortSignal | undefined;
  let input: string | undefined;
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
      log.push("next.clearWidget");
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
      log.push(lines === undefined ? "widget:clear" : `widget:${lines.length}`);
    },
    getEditorText: () => editor,
    setEditorText: (t) => {
      editor = t;
    },
    conversation: () => opts.conversation ?? "user: hi",
    systemPrompt: () => "PROMPT",
    complete: (_p, i, s) =>
      new Promise((res, rej) => {
        input = i;
        signal = s;
        resolveComplete = res;
        rejectComplete = rej;
      }),
    resumeMessage: () => opts.resume,
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
    get input() {
      return input;
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

/** Every host and successor call the fake logs that would reach a terminal. */
const uiCalls = (log: string[]) =>
  log.filter(
    (l) =>
      l.startsWith("notify:") ||
      l.startsWith("next.notify:") ||
      l.startsWith("widget:") ||
      l === "next.clearWidget",
  );

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

test("a seeded resume directive is sent after the baton, ahead of replayed input", async () => {
  const f = fakeHost({ resume: "Continue the goal" });
  const m = new HandoffMachine();
  const done = m.command(f.host, "focus", true);
  m.onInput("typed", undefined);
  f.finishHandoff();
  await done;
  await tick();

  assert.deepEqual(f.next.sent, ["Continue the goal", "typed"]);
  assert.ok(f.log.indexOf("append") < f.log.indexOf("send:Continue the goal"));
});

test("a seeded resume directive is sent even with nothing to replay", async () => {
  const f = fakeHost({ resume: "Continue the goal" });
  const m = new HandoffMachine();
  const done = m.command(f.host, "focus", true);
  f.finishHandoff();
  await done;
  await tick();

  assert.deepEqual(f.next.sent, ["Continue the goal"]);
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

test("interactive: with nothing to replay the successor is told where the baton is", async () => {
  const f = fakeHost();
  const m = new HandoffMachine();
  const done = m.command(f.host, "");
  f.finishHandoff();
  await done;
  await tick();
  assert.ok(
    f.log.some((l) => l.startsWith("next.notify:Handoff attached (/s/x.handoff.md)")),
  );
});

test("headless: writes the baton where asked, attaches it first, touches no UI", async () => {
  const f = fakeHost();
  const m = new HandoffMachine();
  const done = m.command(headlessHost(f.host, "/c/baton.md"), "keep going");
  f.finishHandoff("## Next\ngo\n");
  await done;
  await tick();
  assert.match(f.input ?? "", /keep going/);
  assert.equal(
    f.log.find((l) => l.startsWith("write:")),
    "write:/c/baton.md:## Next\ngo\n",
  );
  assert.match(f.next.appended[0], /^Handoff from the previous session/);
  assert.equal(f.widget, undefined);
  assert.deepEqual(uiCalls(f.log), []);
  assert.equal(m.phase, "idle");
});

test("a bus request while a run is in progress is a no-op", async () => {
  const f = fakeHost({ idle: false });
  const m = new HandoffMachine();
  const done = m.command(f.host, "first");
  assert.equal(m.phase, "armed");
  await m.request(headlessHost(f.host), "again");
  assert.equal(m.phase, "armed");
  f.settle();
  await tick();
  f.finishHandoff();
  await done;
  await tick();
  assert.match(f.input ?? "", /first/);
  assert.equal(m.phase, "idle");
});

test("a bus run does not steal typed inputs and carries its focus note", async () => {
  const f = fakeHost();
  const m = new HandoffMachine();
  const done = m.request(headlessHost(f.host, "/c/baton.md"), "reach green");
  assert.equal(m.onInput("for the agent", undefined), false);
  f.finishHandoff();
  await done;
  await tick();
  assert.match(f.input ?? "", /reach green/);
  assert.deepEqual(f.next.sent, []);
  assert.deepEqual(uiCalls(f.log), []);
});

test("/handoff cancelling a bus run reaches the run's own host, not the user's", async () => {
  const f = fakeHost();
  const m = new HandoffMachine();
  const done = m.request(headlessHost(f.host), "");
  f.editor = "typing";
  await m.command(f.host, "");
  assert.equal(f.signal?.aborted, true);
  assert.equal(m.phase, "idle");
  assert.equal(f.editor, "typing");
  assert.deepEqual(uiCalls(f.log), []);
  f.finishHandoff(null);
  await done;
  assert.equal(f.log.filter((l) => l === "newSession").length, 0);
});

test("headless without a baton path writes beside the transcript", async () => {
  const f = fakeHost();
  const m = new HandoffMachine();
  const done = m.command(headlessHost(f.host), "");
  f.finishHandoff();
  await done;
  await tick();
  assert.ok(f.log.includes("write:/s/x.handoff.md:## Next\ngo\n"));
});

test("headless swallows the cancel path instead of restoring an editor", async () => {
  const f = fakeHost();
  f.cancelNewSession();
  const m = new HandoffMachine();
  const done = m.command(headlessHost(f.host), "");
  m.onInput("a", undefined);
  f.finishHandoff();
  await done;
  assert.equal(f.editor, "");
  assert.equal(m.phase, "idle");
});
