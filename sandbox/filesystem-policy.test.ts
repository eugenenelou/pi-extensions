/**
 * Shared filesystem policy seam:
 *   node --experimental-strip-types --test sandbox/filesystem-policy.test.ts
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  FilesystemPolicy,
  type FolderGrant,
} from "./filesystem-policy.ts";

const roots: string[] = [];

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "pi-filesystem-policy-"));
  roots.push(root);
  const allowed = join(root, "allowed");
  const sibling = join(root, "sibling");
  const protectedChild = join(allowed, "secrets");
  const target = join(root, "target");
  mkdirSync(protectedChild, { recursive: true });
  mkdirSync(sibling);
  mkdirSync(target);
  symlinkSync(target, join(allowed, "link"));
  return { root, allowed, sibling, protectedChild, target };
}

function policy(
  root: string,
  grants: FolderGrant[],
  protectedChild?: string,
): FilesystemPolicy {
  return new FilesystemPolicy(
    {
      denyRead: [root],
      allowWrite: [join(root, "configured-write-root")],
      protectedRead: protectedChild ? [protectedChild] : [],
      protectedWrite: protectedChild ? [protectedChild] : [],
    },
    root,
    grants,
  );
}

test("an exact recursive read grant permits reads but not writes or siblings", () => {
  const f = fixture();
  const current = policy(f.root, [{ root: f.allowed, mode: "read" }]);
  assert.equal(current.evaluate("read", join(f.allowed, "a.txt")).state, "allowed");
  assert.equal(current.evaluate("write", join(f.allowed, "a.txt")).state, "missing");
  assert.equal(current.evaluate("read", join(f.sibling, "a.txt")).state, "missing");
});

test("configured write access does not reopen a non-home read deny", () => {
  const f = fixture();
  const current = new FilesystemPolicy(
    { denyRead: [f.root], allowWrite: [f.allowed] },
    f.root,
  );
  assert.equal(
    current.evaluate("read", join(f.allowed, "visible-to-write.txt")).state,
    "missing",
  );
  assert.equal(
    current.evaluate("write", join(f.allowed, "visible-to-write.txt")).state,
    "missing",
  );
});

test("macOS permits configured read exceptions beneath any deny root", () => {
  const f = fixture();
  const current = new FilesystemPolicy(
    { denyRead: [f.root], allowRead: [f.allowed] },
    f.root,
    [],
    "darwin",
  );
  assert.equal(
    current.evaluate("read", join(f.allowed, "file")).state,
    "allowed",
  );
});

test("recursive macOS search conservatively blocks a protected glob descendant", () => {
  const f = fixture();
  const current = new FilesystemPolicy(
    { protectedRead: [join(f.allowed, "*.pem")] },
    f.root,
    [],
    "darwin",
  );
  assert.equal(current.evaluateReadTree(f.allowed).state, "protected");
});

test("a home tmpfs lets configured writable exceptions remain writable", () => {
  const home = homedir();
  const worktree = join(home, "pi-policy-worktree");
  const current = new FilesystemPolicy(
    { denyRead: [home], allowWrite: [worktree] },
    "/",
    [],
    "linux",
  );
  assert.equal(current.evaluate("write", join(worktree, "file")).state, "allowed");
});

test("a read/write grant permits both modes but explicit protection wins", () => {
  const f = fixture();
  const current = policy(
    f.root,
    [{ root: f.allowed, mode: "read-write" }],
    f.protectedChild,
  );
  assert.equal(current.evaluate("read", join(f.allowed, "a.txt")).state, "allowed");
  assert.equal(current.evaluate("write", join(f.allowed, "a.txt")).state, "allowed");
  assert.equal(current.evaluate("read", join(f.protectedChild, "token")).state, "protected");
  assert.equal(current.evaluate("write", join(f.protectedChild, "token")).state, "protected");
  // A read protection is hidden with a tmpfs by the OS sandbox, which also
  // prevents writes; direct tools must make the same decision.
  const readProtected = new FilesystemPolicy(
    { protectedRead: [f.protectedChild] },
    f.root,
    [{ root: f.allowed, mode: "read-write" }],
  );
  assert.equal(readProtected.evaluate("write", join(f.protectedChild, "new")).state, "protected");
});

test("an existing denyWrite remains protected below a granted parent", () => {
  const f = fixture();
  const current = new FilesystemPolicy(
    { allowWrite: [f.allowed], denyWrite: [f.protectedChild] },
    f.root,
    [{ root: f.allowed, mode: "read-write" }],
  );
  assert.equal(current.evaluate("write", join(f.protectedChild, "token")).state, "protected");
});

test("a trailing recursive glob is a Linux directory exclusion", () => {
  const f = fixture();
  const current = new FilesystemPolicy(
    { denyRead: [`${f.allowed}/**`] },
    f.root,
    [],
    "linux",
  );
  assert.equal(current.evaluate("read", join(f.allowed, "file")).state, "missing");
});

test("configured glob exclusions follow the platform OS jail", () => {
  const f = fixture();
  const config = { allowWrite: [f.root], denyWrite: ["*.pem", "*.key"] };
  const mac = new FilesystemPolicy(config, f.root, [], "darwin");
  assert.equal(
    mac.evaluate("write", join(f.root, "private.pem")).state,
    "protected",
  );
  assert.equal(
    mac.evaluate("write", join(f.root, "private.txt")).state,
    "allowed",
  );
  // bwrap treats the wildcard literally, so the direct-tool decision must not
  // claim a restriction foreground and background Bash do not have.
  const linux = new FilesystemPolicy(config, f.root, [], "linux");
  assert.equal(linux.evaluate("write", join(f.root, "private.pem")).state, "allowed");
});

test("runtime mandatory protections remain protected for direct tools", () => {
  const f = fixture();
  const current = new FilesystemPolicy(
    { allowWrite: [f.root] },
    f.root,
    [{ root: f.allowed, mode: "read-write" }],
  );
  assert.equal(
    current.evaluate("write", join(f.allowed, ".git", "config")).state,
    "protected",
  );
  assert.equal(
    current.evaluate("write", join(f.allowed, ".vscode", "settings.json")).state,
    "protected",
  );
});

test("an external grant retains mandatory protected descendants", () => {
  const f = fixture();
  const external = mkdtempSync(join(tmpdir(), "pi-external-grant-"));
  roots.push(external);
  const current = new FilesystemPolicy(
    { allowWrite: [external] },
    f.root,
    [{ root: external, mode: "read-write" }],
  );
  assert.equal(
    current.evaluate("write", join(external, ".git", "config")).state,
    "protected",
  );
});

test("allowGitConfig permits an explicitly configured Git config write", () => {
  const f = fixture();
  const git = join(f.sibling, ".git");
  mkdirSync(git);
  const current = new FilesystemPolicy(
    { allowWrite: [f.sibling], allowGitConfig: true },
    f.root,
    [{ root: git, mode: "read-write" }],
  );
  assert.equal(
    current.evaluate("write", join(git, "config")).state,
    "allowed",
  );
});

test("a grant rooted at a mandatory protected container cannot write it", () => {
  const f = fixture();
  const protectedRoot = join(f.sibling, ".git");
  mkdirSync(protectedRoot);
  const current = new FilesystemPolicy(
    { allowWrite: [f.sibling] },
    f.root,
    [{ root: protectedRoot, mode: "read-write" }],
  );
  assert.equal(
    current.evaluate("write", join(protectedRoot, "config")).state,
    "protected",
  );
});

test("nested grants mount and evaluate from parent to child", () => {
  const f = fixture();
  const child = join(f.allowed, "child");
  mkdirSync(child);
  const current = new FilesystemPolicy(
    { denyRead: [f.root], allowWrite: [] },
    f.root,
    [
      { root: child, mode: "read-write" },
      { root: f.allowed, mode: "read" },
    ],
  );
  assert.deepEqual(current.grants(), [
    { root: f.allowed, mode: "read" },
    { root: child, mode: "read-write" },
  ]);
  assert.equal(current.evaluate("write", join(child, "file")).state, "allowed");
});

test("a symlink is evaluated at its target rather than under its approved link", () => {
  const f = fixture();
  const current = policy(f.root, [{ root: f.allowed, mode: "read" }]);
  assert.equal(current.evaluate("read", join(f.allowed, "link", "file")).state, "missing");
});

test("an unresolved deep path through an approved symlink fails closed", () => {
  const f = fixture();
  const suffix = Array.from({ length: 41 }, (_, index) => `missing-${index}`);
  const current = new FilesystemPolicy(
    { denyRead: [f.root], allowWrite: [] },
    f.root,
    [{ root: f.allowed, mode: "read-write" }],
  );
  assert.equal(
    current.evaluate("write", join(f.allowed, "link", ...suffix, "file")).state,
    "protected",
  );
});

test("the filesystem root is a recursive policy root", () => {
  const current = new FilesystemPolicy({ denyRead: ["/"] }, "/", []);
  assert.equal(current.evaluate("read", "/tmp/file").state, "missing");
});

test("execution policies add grants without mutating their shared base policy", () => {
  const f = fixture();
  const base = policy(f.root, []);
  const execution = base.withGrants([{ root: f.allowed, mode: "read" }]);
  assert.equal(execution.evaluate("read", join(f.allowed, "a.txt")).state, "allowed");
  assert.equal(base.evaluate("read", join(f.allowed, "a.txt")).state, "missing");
});

test.after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});
