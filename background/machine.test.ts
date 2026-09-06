/**
 * Probe for the background runner's lifecycle, runnable without pi:
 *   node --experimental-strip-types background/machine.test.ts
 */

import assert from "node:assert/strict";
import {
  BackgroundRunner,
  type BackgroundHost,
  type ExitStatus,
} from "./machine.ts";

type Started = {
  command: string;
  logPath: string;
  onExit: (status: ExitStatus) => void;
  killed: boolean;
};

class FakeHost implements BackgroundHost {
  started: Started[] = [];
  logs = new Map<string, string>();
  messages: string[] = [];
  idle = true;
  watchers = new Set<() => void>();

  start(
    command: string,
    logPath: string,
    onExit: (status: ExitStatus) => void,
  ) {
    const entry: Started = { command, logPath, onExit, killed: false };
    this.started.push(entry);
    return {
      kill: () => {
        entry.killed = true;
      },
    };
  }

  logPathFor(id: string): string {
    return `/logs/${id}.log`;
  }

  reads: number[] = [];

  readLog(logPath: string, from: number): { text: string; end: number } {
    this.reads.push(from);
    const whole = this.logs.get(logPath) ?? "";
    return { text: whole.slice(from), end: whole.length };
  }

  watch(check: () => void) {
    this.watchers.add(check);
    return { cancel: () => this.watchers.delete(check) };
  }

  isIdle(): boolean {
    return this.idle;
  }

  sendUserMessage(text: string): void {
    this.messages.push(text);
  }

  /** Drive every live marker watcher once, as a real poll timer would. */
  tick(): void {
    for (const check of [...this.watchers]) check();
  }

  last(): Started {
    return this.started[this.started.length - 1];
  }
}

// run returns an id and a log path, and starts the command once.
{
  const host = new FakeHost();
  const runner = new BackgroundRunner(host);
  const task = runner.run("make build");
  assert.equal(host.started.length, 1);
  assert.equal(host.last().command, "make build");
  assert.equal(task.logPath, host.last().logPath);
  assert.match(task.id, /^bg\d+$/);
  assert.deepEqual(
    runner.running().map((t) => t.command),
    ["make build"],
  );
  // Two tasks never share an id.
  assert.notEqual(runner.run("make test").id, task.id);
}

// wait resolves on exit, with the status and the log path.
{
  const host = new FakeHost();
  const runner = new BackgroundRunner(host);
  const task = runner.run("make build");
  const waiting = runner.wait(task.id, {});
  host.last().onExit({ code: 2, signal: null });
  const result = await waiting;
  assert.equal(result.state, "exited");
  assert.deepEqual(result.exit, { code: 2, signal: null });
  assert.equal(result.logPath, task.logPath);
  assert.equal(result.markerFound, false);
  assert.deepEqual(runner.running(), []);
}

// wait resolves on a marker while the task keeps running.
{
  const host = new FakeHost();
  const runner = new BackgroundRunner(host);
  const task = runner.run("just runserver");
  const waiting = runner.wait(task.id, { marker: "Listening on" });
  host.logs.set(task.logPath, "booting\n");
  host.tick();
  host.logs.set(task.logPath, "booting\nListening on 8000\n");
  host.tick();
  const result = await waiting;
  assert.equal(result.markerFound, true);
  assert.equal(result.state, "running");
  assert.equal(host.watchers.size, 0, "the marker watcher is cancelled");
  assert.deepEqual(
    runner.running().map((t) => t.id),
    [task.id],
  );
}

// kill ends the task and reports it; a second kill is a no-op.
{
  const host = new FakeHost();
  const runner = new BackgroundRunner(host);
  const task = runner.run("sleep 100");
  assert.equal(runner.kill(task.id), true);
  assert.equal(host.last().killed, true);
  host.last().onExit({ code: null, signal: "SIGKILL" });
  assert.deepEqual(runner.running(), []);
  assert.equal(runner.kill(task.id), false);
  assert.deepEqual(host.messages, [], "an explicit kill wakes nobody");
}

// A task ending while the agent is idle wakes it once, with outcome and log.
{
  const host = new FakeHost();
  const runner = new BackgroundRunner(host);
  const task = runner.run("make build");
  host.last().onExit({ code: 0, signal: null });
  assert.equal(host.messages.length, 1);
  assert.match(host.messages[0], /bg1/);
  assert.match(host.messages[0], /make build/);
  assert.match(host.messages[0], /exit code 0/);
  assert.match(host.messages[0], new RegExp(task.logPath));
  runner.flushWakeUps();
  assert.equal(host.messages.length, 1, "the wake-up is sent once");
}

// A task ending while the agent is busy waits for idle.
{
  const host = new FakeHost();
  const runner = new BackgroundRunner(host);
  runner.run("make build");
  runner.run("make test");
  host.idle = false;
  host.started[0].onExit({ code: 0, signal: null });
  host.started[1].onExit({ code: 1, signal: null });
  assert.deepEqual(host.messages, []);
  runner.flushWakeUps();
  assert.equal(host.messages.length, 1, "one message covers both tasks");
  assert.match(host.messages[0], /make build/);
  assert.match(host.messages[0], /make test/);
  runner.flushWakeUps();
  assert.equal(host.messages.length, 1);
}

// An awaited task reports through wait, not through a second wake-up.
{
  const host = new FakeHost();
  const runner = new BackgroundRunner(host);
  const task = runner.run("make build");
  const waiting = runner.wait(task.id, {});
  host.last().onExit({ code: 0, signal: null });
  await waiting;
  runner.flushWakeUps();
  assert.deepEqual(host.messages, []);
}

// Shutdown kills whatever is still running and stops waking the agent.
{
  const host = new FakeHost();
  const runner = new BackgroundRunner(host);
  runner.run("sleep 100");
  runner.run("sleep 200");
  host.started[1].onExit({ code: 0, signal: null });
  host.messages.length = 0;
  runner.shutdown();
  assert.equal(host.started[0].killed, true);
  assert.deepEqual(runner.running(), []);
  host.started[0].onExit({ code: null, signal: "SIGKILL" });
  assert.deepEqual(host.messages, []);
}

// wait and kill on an unknown id are refused, not thrown.
{
  const host = new FakeHost();
  const runner = new BackgroundRunner(host);
  assert.equal(runner.kill("bg99"), false);
  assert.equal(await runner.wait("bg99", {}).then(null, (e) => e.message), "No background task bg99");
}

// An aborted wait stops polling and leaves the task running.
{
  const host = new FakeHost();
  const runner = new BackgroundRunner(host);
  const task = runner.run("just runserver");
  const control = new AbortController();
  const waiting = runner.wait(task.id, {
    marker: "never",
    signal: control.signal,
  });
  control.abort();
  const result = await waiting;
  assert.equal(result.state, "running");
  assert.equal(result.markerFound, false);
  assert.equal(host.watchers.size, 0);
  // The outcome was never delivered, so the exit still wakes the agent.
  host.last().onExit({ code: 0, signal: null });
  assert.equal(host.messages.length, 1);
}

// A wait that returned on a marker still leaves the exit to wake the agent.
{
  const host = new FakeHost();
  const runner = new BackgroundRunner(host);
  const task = runner.run("just runserver");
  const waiting = runner.wait(task.id, { marker: "ready" });
  host.logs.set(task.logPath, "ready\n");
  host.tick();
  await waiting;
  host.last().onExit({ code: 0, signal: null });
  assert.equal(host.messages.length, 1);
}

// A marker split across two polls is still found, and each poll reads only the
// bytes appended since the last one.
{
  const host = new FakeHost();
  const runner = new BackgroundRunner(host);
  const task = runner.run("just runserver");
  const waiting = runner.wait(task.id, { marker: "Listening on" });
  host.logs.set(task.logPath, "booting\nListen");
  host.tick();
  host.logs.set(task.logPath, "booting\nListening on 8000\n");
  host.tick();
  const result = await waiting;
  assert.equal(result.markerFound, true);
  assert.deepEqual(host.reads, [0, "booting\nListen".length]);
}

console.log("background runner lifecycle: ok");
