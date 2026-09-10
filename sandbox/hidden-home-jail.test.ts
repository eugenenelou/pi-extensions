/**
 * Probe the real Linux jail with the whole home directory hidden and only a
 * worktree exposed — the policy codass renders — while the sandbox runtime's
 * own seccomp launcher lives under that hidden home:
 *   node --experimental-strip-types --test sandbox/hidden-home-jail.test.ts
 */

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { BackgroundRunner } from "../background/machine.ts";
import { createNodeHost } from "../background/host.ts";

function skip(reason: string): never {
  console.log(`hidden-home jail: SKIPPED — ${reason}`);
  process.exit(0);
}

if (process.platform !== "linux") skip(`Linux only, not ${process.platform}`);
if (spawnSync("which", ["bwrap"], { stdio: "ignore" }).status !== 0) {
  skip("bubblewrap (bwrap) is not installed");
}

let wrapForSandbox: typeof import("./index.ts").wrapForSandbox;
let bootstrapAssets: typeof import("./index.ts").bootstrapAssets;
let verifySandboxBootstrap: typeof import("./index.ts").verifySandboxBootstrap;
let jailCommand: typeof import("./index.ts").jailCommand;
let SandboxManager: typeof import("@anthropic-ai/sandbox-runtime").SandboxManager;
try {
  ({ wrapForSandbox, bootstrapAssets, verifySandboxBootstrap, jailCommand } =
    await import("./index.ts"));
  ({ SandboxManager } = await import("@anthropic-ai/sandbox-runtime"));
} catch (err) {
  skip(`${err instanceof Error ? err.message : err}`);
}

const HOME = homedir();
// Under the real home: `denyRead: ["~/"]` must hide it like everything else.
const cache = join(HOME, ".cache");
mkdirSync(cache, { recursive: true });
const root = mkdtempSync(join(cache, "pi-hidden-home-"));
const work = join(root, "work dir");
mkdirSync(work);
writeFileSync(join(work, "readable.txt"), "worktree\n");
const secret = join(root, "secret.txt");
writeFileSync(secret, "outside the worktree\n");
const envFile = join(work, ".env");
writeFileSync(envFile, "TOKEN=1\n");
const privateDir = join(work, "private");
mkdirSync(privateDir);
writeFileSync(join(privateDir, "key.txt"), "private\n");

const filesystem = {
  allowWrite: [work, "/tmp"],
  denyWrite: [envFile],
  denyRead: ["~/", privateDir],
  allowRead: [work],
};

try {
  await SandboxManager.initialize({
    network: { httpProxyPort: 1, socksProxyPort: 1 },
    filesystem: {
      allowWrite: filesystem.allowWrite,
      denyRead: filesystem.denyRead,
    },
  } as Parameters<typeof SandboxManager.initialize>[0]);
} catch (err) {
  skip(
    `the Linux jail could not initialize (${err instanceof Error ? err.message : err})`,
  );
}

if (!jailCommand(await wrapForSandbox("true", filesystem, work))) {
  skip("the sandbox runtime produced no bwrap command on this host");
}

async function run(command: string, cwd = work) {
  const wrapped = await wrapForSandbox(command, filesystem, cwd);
  const result = spawnSync("bash", ["-c", wrapped], { cwd, encoding: "utf-8" });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

test.after(async () => {
  await SandboxManager.reset().catch(() => {});
  rmSync(root, { recursive: true, force: true });
});

test("a harmless command runs through the jail", async () => {
  const result = await run("echo hello");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "hello\n");
});

test("the worktree stays readable and writable, quoting included", async () => {
  const read = await run("cat readable.txt");
  assert.equal(read.status, 0, read.stderr);
  assert.equal(read.stdout, "worktree\n");

  const written = join(work, "it's out.txt");
  const write = await run(`echo "written" > "${written}"`);
  assert.equal(write.status, 0, write.stderr);
  assert.equal(readFileSync(written, "utf-8"), "written\n");
});

test("an unrelated file under home is hidden", async () => {
  const result = await run(`cat "${secret}"`);
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, "");
});

test("explicit denies beneath the worktree still hold", async () => {
  const read = await run(`cat "${join(privateDir, "key.txt")}"`);
  assert.notEqual(read.status, 0);
  assert.equal(read.stdout, "");

  const write = await run(`echo TOKEN=2 > "${envFile}"`);
  assert.notEqual(write.status, 0);
  assert.equal(readFileSync(envFile, "utf-8"), "TOKEN=1\n");
});

test("the jail leaves no placeholder files behind for the paths it blocks", async () => {
  const blocked = await run("echo hijack > .zshrc");
  assert.notEqual(blocked.status, 0);
  const dotfiles = readdirSync(work).filter((name) => name.startsWith("."));
  assert.deepEqual(dotfiles, [".env"]);
});

test("a placeholder stays while another jail still mounts it", async () => {
  const wrapped = await wrapForSandbox("sleep 2", filesystem, work);
  const sleeper = spawn("bash", ["-c", wrapped], {
    cwd: work,
    stdio: "ignore",
  });
  const exited = new Promise<void>((resolve) =>
    sleeper.on("close", () => resolve()),
  );
  await new Promise((resolve) => setTimeout(resolve, 500));
  const zshrc = join(work, ".zshrc");
  assert.ok(existsSync(zshrc), "the sleeping jail's placeholder is missing");

  await run("true");
  assert.ok(
    existsSync(zshrc),
    "a finished jail removed a live jail's placeholder",
  );

  await exited;
  assert.ok(!existsSync(zshrc), "the last jail left its placeholder behind");
});

test("the runtime's launch files are visible but not writable", async () => {
  const assets = bootstrapAssets(
    await wrapForSandbox("true", filesystem, work),
  );
  assert.equal(assets.length, 2, "the runtime launches through apply-seccomp");
  for (const asset of assets) {
    const stat = await run(`test -r "${asset}"`);
    assert.equal(stat.status, 0, `${asset} is hidden inside the jail`);
    const before = readFileSync(asset);
    const write = await run(`echo tamper >> "${asset}"`);
    assert.notEqual(write.status, 0, `${asset} was writable inside the jail`);
    assert.deepEqual(readFileSync(asset), before);
  }
});

test("seccomp is active: no new Unix sockets", async () => {
  if (spawnSync("which", ["python3"], { stdio: "ignore" }).status !== 0) return;
  const probe = `python3 -c 'import socket; socket.socket(socket.AF_UNIX)'`;
  assert.equal(spawnSync("bash", ["-c", probe]).status, 0, "host can");
  const result = await run(probe);
  assert.notEqual(result.status, 0, "the jail let a Unix socket be created");
});

test("a background command gets the same jail", async () => {
  const runner = new BackgroundRunner(
    createNodeHost({
      cwd: work,
      wrap: (command) => wrapForSandbox(command, filesystem, work),
      isIdle: () => true,
      sendUserMessage: () => {},
    }),
  );
  const keepAlive = setInterval(() => {}, 25);
  try {
    const task = runner.run(`cat readable.txt && cat "${secret}"`);
    const result = await runner.wait(task.id, {});
    assert.equal(result.state, "exited");
    assert.notEqual(result.exit?.code, 0, "the hidden file was readable");
    const log = readFileSync(result.logPath, "utf-8");
    assert.match(log, /worktree/);
    assert.doesNotMatch(log, /outside the worktree/);
  } finally {
    clearInterval(keepAlive);
  }
});

test("a read-only working directory without dot-entries still runs", async () => {
  // Nothing under /usr/share is writable in the jail, so a `.claude` that
  // does not exist there needs no creation-blocking mount.
  const result = await run("pwd", "/usr/share");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "/usr/share\n");
});

test("the start-up check passes here and names a deny that hides the launcher", async () => {
  assert.deepEqual(await verifySandboxBootstrap(filesystem, work), {
    ok: true,
  });

  const [applier] = bootstrapAssets(
    await wrapForSandbox("true", filesystem, work),
  );
  const hidden = dirname(applier);
  const result = await verifySandboxBootstrap(
    { ...filesystem, denyRead: [...filesystem.denyRead, hidden] },
    work,
  );
  assert.equal(result.ok, false);
  assert.ok(
    !result.ok && result.reason.includes(applier),
    result.ok ? "" : result.reason,
  );
  assert.ok(
    !result.ok && result.reason.includes(hidden),
    result.ok ? "" : result.reason,
  );
});

test("a worktree's git pointer is frozen, not masked, when the main .git is writable", async () => {
  const mainRepo = mkdtempSync(join(root, "pi-worktree-main-"));
  const worktree = join(root, "pi-worktree-wt");
  spawnSync("git", ["init", "-b", "main", mainRepo]);
  spawnSync(
    "git",
    [
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@t",
      "commit",
      "--allow-empty",
      "-m",
      "init",
    ],
    { cwd: mainRepo },
  );
  spawnSync("git", ["worktree", "add", worktree], { cwd: mainRepo });

  const wtFilesystem = {
    ...filesystem,
    allowWrite: [worktree, join(mainRepo, ".git"), "/tmp"],
    allowRead: [worktree],
  };
  const wtRun = async (command: string) => {
    const wrapped = await wrapForSandbox(command, wtFilesystem, worktree);
    return spawnSync("bash", ["-c", wrapped], {
      cwd: worktree,
      encoding: "utf-8",
    });
  };

  const rev = await wtRun("git rev-parse --git-dir");
  assert.equal(rev.status, 0, rev.stderr);
  assert.match(rev.stdout, /worktrees\//);

  const commit = await wtRun(
    `git -c user.name=t -c user.email=t@t commit --allow-empty -m x`,
  );
  assert.equal(commit.status, 0, commit.stderr);
  const checkout = await wtRun("git checkout -b probe");
  assert.equal(checkout.status, 0, checkout.stderr);
  const rebase = await wtRun("git rebase main");
  assert.equal(rebase.status, 0, rebase.stderr);

  const pointerPath = join(worktree, ".git");
  const tamperPointer = await wtRun(`echo x >> "${pointerPath}"`);
  assert.notEqual(tamperPointer.status, 0);
  assert.match(readFileSync(pointerPath, "utf-8"), /^gitdir: /);

  const hookPath = join(mainRepo, ".git", "hooks", "pre-commit");
  const tamperHook = await wtRun(`echo x > "${hookPath}"`);
  assert.notEqual(tamperHook.status, 0);
  assert.ok(!existsSync(hookPath));

  const configPath = join(mainRepo, ".git", "config");
  const configBefore = readFileSync(configPath, "utf-8");
  const tamperConfig = await wtRun(`echo x >> "${configPath}"`);
  assert.notEqual(tamperConfig.status, 0);
  assert.equal(readFileSync(configPath, "utf-8"), configBefore);
});
