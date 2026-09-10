import assert from "node:assert/strict";
import { test } from "node:test";
import { type FileHost, HandoffFile } from "./file.ts";

function fakeHost(
  opts: { idle?: boolean; conversation?: string | undefined } = {},
) {
  const log: string[] = [];
  let idle = opts.idle ?? true;
  let resolveIdle = () => {};
  let resolveComplete: (text: string | null) => void = () => {};
  let input: string | undefined;
  let status: string[] | undefined;
  const host: FileHost = {
    isIdle: () => idle,
    waitForIdle: () => new Promise<void>((r) => (resolveIdle = r)),
    conversation: () =>
      "conversation" in opts ? opts.conversation : "user: hi",
    systemPrompt: () => "PROMPT",
    complete: (_p, i) =>
      new Promise((res) => {
        input = i;
        resolveComplete = res;
      }),
    handoffPath: () => "/s/x.handoff.md",
    writeFile: (p, t) => log.push(`write:${p}:${t}`),
    notify: (m) => log.push(`notify:${m}`),
    setStatus: (lines) => {
      status = lines;
      log.push(lines === undefined ? "status:clear" : `status:${lines[0]}`);
    },
  };
  return {
    host,
    log,
    settle: () => {
      idle = true;
      resolveIdle();
    },
    finish: (text: string | null = "## Next\ngo") => resolveComplete(text),
    fail: () => {
      host.writeFile = () => {
        throw new Error("boom");
      };
    },
    get input() {
      return input;
    },
    get status() {
      return status;
    },
  };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

test("idle: writes the baton beside the transcript and says where", async () => {
  const f = fakeHost();
  const file = new HandoffFile();
  const done = file.write(f.host, "keep the migration details");
  f.finish("## Next\nrun migrations\n");
  await done;

  assert.match(f.input ?? "", /keep the migration details/);
  assert.deepEqual(f.log, [
    "status:Handoff file: writing…",
    "write:/s/x.handoff.md:## Next\nrun migrations\n",
    "notify:Handoff file written (/s/x.handoff.md)",
    "status:clear",
  ]);
});

test("busy: the write is scheduled, shown, and runs once the agent settles", async () => {
  const f = fakeHost({ idle: false });
  const file = new HandoffFile();
  const done = file.write(f.host, "");

  assert.deepEqual(f.status, [
    "Handoff file: scheduled, writes when the agent settles",
  ]);
  // The status line carries the wait on its own: no notification doubles it.
  assert.deepEqual(f.log.filter((l) => l.startsWith("notify:")), []);
  assert.equal(f.input, undefined);

  f.settle();
  await tick();
  assert.deepEqual(f.status, ["Handoff file: writing…"]);
  f.finish();
  await done;
  assert.ok(f.log.some((l) => l.startsWith("write:")));
  assert.equal(f.status, undefined);
});

test("a second command while one is in flight is refused, not queued", async () => {
  const f = fakeHost({ idle: false });
  const file = new HandoffFile();
  const done = file.write(f.host, "first");

  await file.write(f.host, "second");
  assert.ok(f.log.includes("notify:Handoff file already in progress"));
  assert.deepEqual(f.status, [
    "Handoff file: scheduled, writes when the agent settles",
  ]);

  f.settle();
  await tick();
  f.finish();
  await done;
  assert.match(f.input ?? "", /first/);
  assert.equal(f.log.filter((l) => l.startsWith("write:")).length, 1);
});

test("an empty conversation writes nothing and calls no model", async () => {
  const f = fakeHost({ conversation: undefined });
  const file = new HandoffFile();
  await file.write(f.host, "");
  assert.deepEqual(f.log, ["notify:No conversation to hand off", "status:clear"]);
  assert.equal(f.input, undefined);
});

test("a failure reports, clears the status, and frees the writer", async () => {
  const f = fakeHost();
  f.fail();
  const file = new HandoffFile();
  const done = file.write(f.host, "");
  f.finish();
  await done;

  assert.ok(f.log.includes("notify:Handoff file failed: boom"));
  assert.equal(f.status, undefined);

  const again = file.write(f.host, "retry");
  f.finish();
  await again;
  assert.match(f.input ?? "", /retry/);
});
