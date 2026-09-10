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
  writeFileSync,
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
    `${err instanceof Error ? err.message : err} — run pnpm install so sandbox/node_modules resolves @earendil-works/pi-coding-agent and @anthropic-ai/sandbox-runtime`,
  );
}

const dir = mkdtempSync(join(tmpdir(), "pi-background-jail-"));
const work = join(dir, "work");
mkdirSync(work);
const denied = join(dir, "denied.txt");
const allowed = join(work, "allowed.txt");
const executionRoot = join(dir, "execution-grant");
const protectedChild = join(executionRoot, "protected");
mkdirSync(protectedChild, { recursive: true });
const readOnlyFile = join(executionRoot, "read-only.txt");
writeFileSync(readOnlyFile, "readable\n");

const filesystem = {
  allowWrite: [work],
  denyRead: [executionRoot],
  protectedRead: [protectedChild],
};
// No domain allowlist, so nothing here restricts the network; the proxy ports
// are declared as external only so the runtime starts no server of its own.
try {
  await SandboxManager.initialize({
    network: { httpProxyPort: 1, socksProxyPort: 1 },
    // `protectedRead` is extension-only; the effective runtime policy also
    // denies writes so this initial manager state matches wrapped executions.
    filesystem: {
      allowWrite: [work],
      denyRead: [executionRoot, protectedChild],
      denyWrite: [protectedChild],
    },
  } as Parameters<typeof SandboxManager.initialize>[0]);
} catch (err) {
  skip(
    `the Linux jail could not initialize (${err instanceof Error ? err.message : err})`,
  );
}

const wrap = (command: string) => wrapForSandbox(command, filesystem);
if (!(await wrap("true")).startsWith("bwrap ")) {
  skip("the sandbox runtime produced no bwrap command on this host");
}

function runnerFor(
  activeWrap: (command: string, executionId?: string) => Promise<string>,
): BackgroundRunner {
  return new BackgroundRunner(
    createNodeHost({
      cwd: work,
      wrap: activeWrap,
      isIdle: () => true,
      sendUserMessage: () => {},
    }),
  );
}

const runner = runnerFor(wrap);

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
// the jail, not a broken runner. Foreground bash receives the same confinement.
{
  const task = runner.run(`echo hello > ${allowed}`);
  const result = await settled(runner.wait(task.id, {}));
  assert.equal(result.exit?.code, 0, readFileSync(result.logPath, "utf-8"));
  assert.equal(readFileSync(allowed, "utf-8"), "hello\n");

  const foregroundAllowed = spawnSync(
    "bash",
    ["-c", await wrapForSandbox(`echo foreground > ${join(work, "foreground.txt")}`, filesystem, work)],
    { cwd: work, encoding: "utf-8" },
  );
  assert.equal(foregroundAllowed.status, 0, foregroundAllowed.stderr);
  assert.equal(readFileSync(join(work, "foreground.txt"), "utf-8"), "foreground\n");

  const foregroundDenied = spawnSync(
    "bash",
    ["-c", await wrapForSandbox(`echo denied > ${join(dir, "foreground-denied.txt")}`, filesystem, work)],
    { cwd: work, encoding: "utf-8" },
  );
  assert.notEqual(foregroundDenied.status, 0, foregroundDenied.stderr);
  assert.equal(existsSync(join(dir, "foreground-denied.txt")), false);
}

// A read-only execution grant permits a background read but never a write.
{
  const readOnly = runnerFor((command: string) =>
    wrapForSandbox(command, filesystem, work, [
      { root: executionRoot, mode: "read" },
    ]),
  );
  const readTask = readOnly.run(`cat ${readOnlyFile}`);
  const readResult = await settled(readOnly.wait(readTask.id, {}));
  assert.equal(readResult.exit?.code, 0, readFileSync(readResult.logPath, "utf-8"));
  assert.match(readFileSync(readResult.logPath, "utf-8"), /readable/);

  const writeTask = readOnly.run(`echo no > ${join(executionRoot, "read-grant-write.txt")}`);
  const writeResult = await settled(readOnly.wait(writeTask.id, {}));
  assert.notEqual(writeResult.exit?.code, 0, readFileSync(writeResult.logPath, "utf-8"));
}

// An execution-specific grant reaches only the process built with it. A later
// background launch starts from the unchanged base policy, and a protected
// descendant remains denied even while its parent is temporarily writable.
{
  const scoped = join(executionRoot, "scoped.txt");
  const grantedWrap = (command: string) =>
    wrapForSandbox(command, filesystem, work, [
      { root: executionRoot, mode: "read-write" },
    ]);
  const granted = runnerFor(grantedWrap);
  const grantedTask = granted.run(`echo granted > ${scoped}`);
  const grantedResult = await settled(granted.wait(grantedTask.id, {}));
  assert.equal(grantedResult.exit?.code, 0, readFileSync(grantedResult.logPath, "utf-8"));
  assert.equal(readFileSync(scoped, "utf-8"), "granted\n");

  // Match the published sandbox wrapper's execution-ID map on one runner:
  // concurrently launched jobs must receive only their own scoped capability.
  const grantsByExecution = new Map([
    ["granted", [{ root: executionRoot, mode: "read-write" as const }]],
  ]);
  const shared = runnerFor((command, executionId) =>
    wrapForSandbox(
      command,
      filesystem,
      work,
      grantsByExecution.get(executionId ?? "") ?? [],
    ),
  );
  const concurrentGrantedTask = shared.run(
    `echo concurrent > ${join(executionRoot, "concurrent.txt")}`,
    "granted",
  );
  const laterTask = shared.run(
    `echo leaked > ${join(executionRoot, "later.txt")}`,
    "ungranted",
  );
  const [concurrentGrantedResult, laterResult] = await Promise.all([
    settled(shared.wait(concurrentGrantedTask.id, {})),
    settled(shared.wait(laterTask.id, {})),
  ]);
  assert.equal(concurrentGrantedResult.exit?.code, 0, readFileSync(concurrentGrantedResult.logPath, "utf-8"));
  // The hidden root is a scratch overlay inside the jail, so the write itself
  // may succeed; what matters is that nothing reaches the host.
  assert.equal(laterResult.state, "exited", readFileSync(laterResult.logPath, "utf-8"));
  assert.equal(existsSync(join(executionRoot, "later.txt")), false, "an ungranted job wrote to the host");

  const protectedTask = granted.run(`echo no > ${join(protectedChild, "secret.txt")}`);
  const protectedResult = await settled(granted.wait(protectedTask.id, {}));
  assert.equal(protectedResult.state, "exited", readFileSync(protectedResult.logPath, "utf-8"));
  assert.equal(existsSync(join(protectedChild, "secret.txt")), false, "a protected child was written on the host");
}

await SandboxManager.reset().catch(() => {});
rmSync(dir, { recursive: true, force: true });
console.log("background under the real sandbox: ok");
