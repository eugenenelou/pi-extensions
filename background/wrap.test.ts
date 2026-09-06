/**
 * Probe that a background command really runs through the wrap the sandbox
 * extension publishes, with real processes:
 *   node --experimental-strip-types background/wrap.test.ts
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BackgroundRunner } from "./machine.ts";
import { createNodeHost } from "./host.ts";
import { resolveWrap, type SandboxWrap } from "./sandbox.ts";

const dir = mkdtempSync(join(tmpdir(), "pi-background-wrap-"));
const denied = join(dir, "denied.txt");
const allowed = join(dir, "allowed.txt");

type Globals = {
  __codassSandbox?: { active: boolean; reason?: string };
  __codassSandboxWrap?: SandboxWrap;
};

function publish(wrap: SandboxWrap): void {
  const globals = globalThis as Globals;
  globals.__codassSandbox = { active: true };
  globals.__codassSandboxWrap = wrap;
}

/**
 * A detached child is unref'd, so nothing here holds the event loop open while
 * the command runs — the agent process does that in a real session.
 */
async function settled<T>(promise: Promise<T>): Promise<T> {
  const keepAlive = setInterval(() => {}, 25);
  try {
    return await promise;
  } finally {
    clearInterval(keepAlive);
  }
}

function runnerOnPublishedWrap(): BackgroundRunner {
  const resolved = resolveWrap(globalThis as Globals);
  assert.ok("wrap" in resolved, "the published wrap is the one resolved");
  return new BackgroundRunner(
    createNodeHost({
      cwd: dir,
      wrap: resolved.wrap,
      isIdle: () => true,
      sendUserMessage: () => {},
    }),
  );
}

// What the OS runs is the wrap's output, not the command as written: a wrap
// that rewrites the command's target makes the command hit the rewritten one.
{
  publish(async (command) => command.replaceAll(denied, allowed));
  const runner = runnerOnPublishedWrap();
  const task = runner.run(`echo hello > ${denied}`);
  const result = await settled(runner.wait(task.id, {}));
  assert.equal(result.state, "exited");
  assert.equal(result.exit?.code, 0);
  assert.equal(existsSync(denied), false, "the raw command never ran");
  assert.equal(readFileSync(allowed, "utf-8"), "hello\n");
}

// A wrap that refuses fails the background command, denial in its log, exactly
// as a refused bash command fails.
{
  publish(async () => `echo "bwrap: Read-only file system" >&2; exit 13`);
  const runner = runnerOnPublishedWrap();
  const task = runner.run(`echo hello > ${denied}`);
  const result = await settled(runner.wait(task.id, {}));
  assert.equal(result.exit?.code, 13);
  assert.equal(existsSync(denied), false);
  assert.match(readFileSync(result.logPath, "utf-8"), /Read-only file system/);
  rmSync(result.logPath, { force: true });
}

// A wrap that throws leaves the command unrun and says so in the log.
{
  publish(async () => {
    throw new Error("sandbox is gone");
  });
  const runner = runnerOnPublishedWrap();
  const task = runner.run(`echo hello > ${denied}`);
  const result = await settled(runner.wait(task.id, {}));
  assert.notEqual(result.exit?.code, 0);
  assert.equal(existsSync(denied), false);
  assert.match(readFileSync(result.logPath, "utf-8"), /sandbox is gone/);
  rmSync(result.logPath, { force: true });
}

rmSync(dir, { recursive: true, force: true });
console.log("background runs through the published wrap: ok");
