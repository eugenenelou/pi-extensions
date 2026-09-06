/**
 * Probe that a background command is confined by the real jail, not by a stand-in:
 *   node --experimental-strip-types sandbox/background-wrap.test.ts
 *
 * It lives here rather than beside the runner because the wrap and the sandbox
 * runtime resolve from this package's `node_modules`.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BackgroundRunner } from "../background/machine.ts";
import { createNodeHost } from "../background/host.ts";

function skip(reason: string): never {
  console.log(`background under the real sandbox: SKIPPED — ${reason}`);
  process.exit(0);
}

if (process.platform !== "linux") {
  skip(`this probe only knows the Linux jail, not ${process.platform}`);
}
if (spawnSync("which", ["bwrap"], { stdio: "ignore" }).status !== 0) {
  skip("bubblewrap (bwrap) is not installed");
}

let wrapForSandbox: typeof import("./index.ts").wrapForSandbox;
let SandboxManager: typeof import("@anthropic-ai/sandbox-runtime").SandboxManager;
try {
  ({ wrapForSandbox } = await import("./index.ts"));
  ({ SandboxManager } = await import("@anthropic-ai/sandbox-runtime"));
} catch (err) {
  skip(
    `${err instanceof Error ? err.message : err} — pi supplies @earendil-works/pi-coding-agent at runtime; link the installed pi package into sandbox/node_modules to run this probe`,
  );
}

const dir = mkdtempSync(join(tmpdir(), "pi-background-jail-"));
const work = join(dir, "work");
mkdirSync(work);
const denied = join(dir, "denied.txt");
const allowed = join(work, "allowed.txt");

const filesystem = { allowWrite: [work] };
// No domain allowlist, so nothing here restricts the network; the proxy ports
// are declared as external only so the runtime starts no server of its own.
await SandboxManager.initialize({
  network: { httpProxyPort: 1, socksProxyPort: 1 },
  filesystem,
} as Parameters<typeof SandboxManager.initialize>[0]);

const wrap = (command: string) => wrapForSandbox(command, filesystem);
if (!(await wrap("true")).startsWith("bwrap ")) {
  skip("the sandbox runtime produced no bwrap command on this host");
}

const runner = new BackgroundRunner(
  createNodeHost({
    cwd: work,
    wrap,
    isIdle: () => true,
    sendUserMessage: () => {},
  }),
);

/** Nothing else holds the event loop open around a detached, unref'd child. */
async function settled<T>(promise: Promise<T>): Promise<T> {
  const keepAlive = setInterval(() => {}, 25);
  try {
    return await promise;
  } finally {
    clearInterval(keepAlive);
  }
}

// A write the sandbox denies fails the background command, as it fails from bash.
{
  const task = runner.run(`echo hello > ${denied}`);
  const result = await settled(runner.wait(task.id, {}));
  assert.equal(result.state, "exited");
  assert.notEqual(result.exit?.code, 0, readFileSync(result.logPath, "utf-8"));
  assert.equal(existsSync(denied), false, "the denied path was written anyway");
}

// The same command against a writable path goes through: the failure above is
// the jail, not a broken runner.
{
  const task = runner.run(`echo hello > ${allowed}`);
  const result = await settled(runner.wait(task.id, {}));
  assert.equal(result.exit?.code, 0, readFileSync(result.logPath, "utf-8"));
  assert.equal(readFileSync(allowed, "utf-8"), "hello\n");
}

await SandboxManager.reset().catch(() => {});
rmSync(dir, { recursive: true, force: true });
console.log("background under the real sandbox: ok");
