/**
 * Probe for the order the tool_call guard decides in:
 *   node --experimental-strip-types --test sandbox/tool-call.test.ts
 *
 * The built-in file tools are exempt from the judge only because the rendered
 * permissions file names them, so each case here deploys its own allow list.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  applyAllowRead,
  applyExecutionGrants,
  bootstrapAssets,
  dropMissingDevNullBinds,
  applyMacReadGrants,
  sandboxPathReason,
} from "./index.ts";

/** The baseline codass renders: `PI_PERMISSION_ALLOW` in the pi target. */
const BASELINE = ["edit", "find", "grep", "ls", "read", "write"];

type ToolCallEvent = { toolName: string; input: unknown };
type Handler = (
  event: ToolCallEvent,
  ctx: ExtensionContext,
) => Promise<{ block: true; reason: string } | undefined>;

const roots: string[] = [];

/**
 * The extension activated against a fake pi, with the agent dir and the
 * project both under a temp root so only *allow* is deployed: no judge model
 * is configured, so any call that reaches the judge blocks and says so.
 *
 * codass renders the list into the profile's agent dir or into the project,
 * depending on the deploy; both are read here.
 */
async function activate(deployed: {
  profile?: string[];
  project?: string[];
}): Promise<{
  toolCall: Handler;
  cwd: string;
}> {
  const root = mkdtempSync(join(tmpdir(), "pi-tool-call-"));
  roots.push(root);
  const agentDir = join(root, "agent");
  const cwd = join(root, "project");
  mkdirSync(join(agentDir, "extensions"), { recursive: true });
  mkdirSync(join(cwd, ".pi", "extensions"), { recursive: true });
  if (deployed.profile) {
    writeFileSync(
      join(agentDir, "extensions", "permissions.json"),
      JSON.stringify({ allow: deployed.profile }),
    );
  }
  if (deployed.project) {
    writeFileSync(
      join(cwd, ".pi", "extensions", "permissions.json"),
      JSON.stringify({ allow: deployed.project }),
    );
  }
  process.env.PI_CODING_AGENT_DIR = agentDir;

  const handlers = new Map<string, unknown>();
  const pi = {
    registerFlag: () => {},
    registerTool: () => {},
    registerCommand: () => {},
    getFlag: () => false,
    on: (name: string, handler: unknown) => handlers.set(name, handler),
  } as unknown as ExtensionAPI;
  const { default: extension } = await import("./index.ts");
  extension(pi);
  return { toolCall: handlers.get("tool_call") as Handler, cwd };
}

const context = (cwd: string) => ({ cwd, hasUI: false }) as ExtensionContext;

test("a built-in tool the allow list names runs without a judge", async () => {
  const { toolCall, cwd } = await activate({ profile: BASELINE });
  assert.equal(
    await toolCall(
      { toolName: "read", input: { path: join(cwd, "notes.md") } },
      context(cwd),
    ),
    undefined,
  );
});

test("a built-in tool the allow list omits goes to the judge", async () => {
  const { toolCall, cwd } = await activate({ project: ["Bash(git status:*)"] });
  const decision = await toolCall(
    { toolName: "read", input: { path: join(cwd, "notes.md") } },
    context(cwd),
  );
  assert.match(decision?.reason ?? "", /no judge model configured/);
});

test("the env-file guard stops a write the allow list allows", async () => {
  const { toolCall, cwd } = await activate({ project: BASELINE });
  const decision = await toolCall(
    { toolName: "write", input: { path: join(cwd, ".env") } },
    context(cwd),
  );
  assert.deepEqual(decision, {
    block: true,
    reason: "sandbox guard: write to .env",
  });
});

test("the sandbox-path guard refuses a write outside allowWrite", () => {
  assert.match(
    sandboxPathReason("write", "/etc/hosts", "/work", {
      allowWrite: ["/work"],
    }) ?? "",
    /outside the sandbox allowWrite list/,
  );
});

test("recursive search cannot traverse a protected descendant", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-search-protection-"));
  roots.push(root);
  const protectedChild = join(root, ".ssh");
  mkdirSync(protectedChild);
  assert.match(
    sandboxPathReason("grep", root, root, {
      protectedRead: [protectedChild],
    }) ?? "",
    /protected/,
  );
});

test("missing dev-null bind targets with spaces are removed whole", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-bind-space-"));
  roots.push(root);
  const missing = join(root, "missing target");
  const wrapped = dropMissingDevNullBinds(
    `bwrap --ro-bind / / --ro-bind /dev/null '${missing}' -- bash -c true`,
  );
  assert.doesNotMatch(wrapped, /dev\/null/);
  assert.doesNotMatch(wrapped, /missing target/);
});

test("execution grants rebind a denied folder after the jail's default hide", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-execution-grant-"));
  roots.push(root);
  const approved = join(root, "approved");
  const protectedChild = join(approved, "protected");
  mkdirSync(protectedChild, { recursive: true });
  const wrapped = applyExecutionGrants(
    `bwrap --ro-bind / / --tmpfs ${root} -- bash -c true`,
    [{ root: approved, mode: "read" }],
    root,
    [protectedChild],
    [protectedChild],
  );
  assert.ok(
    wrapped.indexOf(`--ro-bind ${approved} ${approved}`) >
      wrapped.indexOf(`--tmpfs ${root}`),
    wrapped,
  );
  assert.ok(
    wrapped.indexOf(`--ro-bind ${protectedChild} ${protectedChild}`) >
      wrapped.indexOf(`--ro-bind ${approved} ${approved}`),
    wrapped,
  );
  assert.ok(
    wrapped.indexOf(`--tmpfs ${protectedChild}`) >
      wrapped.indexOf(`--ro-bind ${protectedChild} ${protectedChild}`),
    wrapped,
  );
  const missingProtected = join(approved, "missing", "secret");
  const missingWrapped = applyExecutionGrants(
    `bwrap --ro-bind / / --tmpfs ${root} -- bash -c true`,
    [{ root: approved, mode: "read-write" }],
    root,
    [],
    [missingProtected],
  );
  assert.ok(
    missingWrapped.includes(`--ro-bind /dev/null ${join(approved, "missing")}`),
    missingWrapped,
  );
});

test("a read/write grant remains writable after a normal read allow bind", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-writable-grant-"));
  roots.push(root);
  const approved = join(root, "approved");
  mkdirSync(approved);
  const wrapped = applyExecutionGrants(
    `bwrap --ro-bind / / --ro-bind ${approved} ${approved} -- bash -c true`,
    [{ root: approved, mode: "read-write" }],
    root,
    [],
    [],
    [approved],
  );
  assert.ok(
    wrapped.lastIndexOf(`--bind ${approved} ${approved}`) >
      wrapped.lastIndexOf(`--ro-bind ${approved} ${approved}`),
    wrapped,
  );
});

test("runtime source-target protection binds remain after a parent grant", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-runtime-protection-"));
  roots.push(root);
  const approved = join(root, "approved");
  const protectedChild = join(approved, ".git", "config");
  mkdirSync(dirname(protectedChild), { recursive: true });
  const wrapped = applyExecutionGrants(
    `bwrap --ro-bind / / --ro-bind ${protectedChild} ${protectedChild} -- bash -c true`,
    [{ root: approved, mode: "read-write" }],
    root,
    [],
    [],
    [approved],
  );
  assert.ok(
    wrapped.lastIndexOf(`--ro-bind ${protectedChild} ${protectedChild}`) >
      wrapped.indexOf(`--bind ${approved} ${approved}`),
    wrapped,
  );
});

test("external grant binds reapply mandatory protected descendants", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-external-protection-"));
  roots.push(root);
  const external = join(root, "external");
  mkdirSync(external);
  const wrapped = applyExecutionGrants(
    "bwrap --ro-bind / / -- bash -c true",
    [{ root: external, mode: "read-write" }],
    root,
    [],
    [],
  );
  assert.ok(
    wrapped.indexOf(`--ro-bind /dev/null ${join(external, ".git")}`) >
      wrapped.indexOf(`--bind ${external} ${external}`),
    wrapped,
  );
});

test("a configured external write root preserves mandatory protected descendants", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-configured-protection-"));
  roots.push(root);
  const external = join(root, "external");
  mkdirSync(external);
  const wrapped = applyExecutionGrants(
    "bwrap --ro-bind / / -- bash -c true",
    [],
    root,
    [],
    [],
    [],
    false,
    [external],
  );
  assert.ok(
    wrapped.includes(`--ro-bind /dev/null ${join(external, ".git")}`),
    wrapped,
  );
});

test("a broad grant re-applies mandatory protections at a deep command cwd", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-broad-grant-"));
  roots.push(root);
  const cwd = join(root, "one", "two", "three", "work");
  mkdirSync(cwd, { recursive: true });
  const wrapped = applyExecutionGrants(
    "bwrap --ro-bind / / -- bash -c true",
    [{ root, mode: "read-write" }],
    cwd,
    [],
    [],
  );
  assert.ok(
    wrapped.includes(`--ro-bind /dev/null ${join(cwd, ".claude")}`),
    wrapped,
  );
});

test("a materialized mandatory ancestor never receives descendant bind targets", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-materialized-protection-"));
  roots.push(root);
  const external = join(root, "external");
  mkdirSync(external);
  writeFileSync(join(external, ".git"), "");
  const wrapped = applyExecutionGrants(
    "bwrap --ro-bind / / -- bash -c true",
    [],
    root,
    [],
    [],
    [],
    false,
    [external],
  );
  const pointer = join(external, ".git");
  assert.ok(wrapped.includes(`--ro-bind ${pointer} ${pointer}`), wrapped);
  assert.doesNotMatch(wrapped, /--ro-bind \/dev\/null [^\s]*\.git(?:\s|$)/);
  assert.doesNotMatch(wrapped, /\.git\/(?:hooks|config)/);
});

test("an external grant preserves nested mandatory protected descendants", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-nested-protection-"));
  roots.push(root);
  const external = join(root, "external");
  const nestedGit = join(external, "nested", ".git");
  mkdirSync(nestedGit, { recursive: true });
  const wrapped = applyExecutionGrants(
    "bwrap --ro-bind / / -- bash -c true",
    [{ root: external, mode: "read-write" }],
    root,
    [],
    [],
  );
  assert.ok(
    wrapped.includes(`--ro-bind /dev/null ${join(nestedGit, "config")}`),
    wrapped,
  );
});

test("a grant rooted at a mandatory protected container preserves descendants", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-protected-root-"));
  roots.push(root);
  const protectedRoot = join(root, ".git");
  mkdirSync(protectedRoot);
  const wrapped = applyExecutionGrants(
    "bwrap --ro-bind / / -- bash -c true",
    [{ root: protectedRoot, mode: "read-write" }],
    root,
    [],
    [],
  );
  assert.ok(
    wrapped.includes(`--bind ${protectedRoot} ${protectedRoot}`),
    wrapped,
  );
  assert.ok(
    wrapped.includes(`--ro-bind /dev/null ${join(protectedRoot, "config")}`),
    wrapped,
  );
});

test("nested grants mount from parent to child", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-nested-grants-"));
  roots.push(root);
  const parent = join(root, "parent");
  const child = join(parent, "child");
  mkdirSync(child, { recursive: true });
  const wrapped = applyExecutionGrants(
    "bwrap --ro-bind / / -- bash -c true",
    [
      { root: child, mode: "read-write" },
      { root: parent, mode: "read" },
    ],
    root,
    [],
    [],
  );
  assert.ok(
    wrapped.indexOf(`--ro-bind ${parent} ${parent}`) <
      wrapped.indexOf(`--bind ${child} ${child}`),
    wrapped,
  );
});

test("an ancestor write exclusion neither leaks nor becomes writable through a grant", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-ancestor-deny-"));
  roots.push(root);
  const parent = join(root, "hidden");
  const approved = join(parent, "approved");
  mkdirSync(approved, { recursive: true });
  const wrapped = applyExecutionGrants(
    `bwrap --ro-bind / / --tmpfs ${parent} -- bash -c true`,
    [{ root: approved, mode: "read-write" }],
    root,
    [],
    [parent],
  );
  assert.doesNotMatch(wrapped, new RegExp(`--ro-bind ${parent} ${parent}`));
  assert.ok(wrapped.includes(`--ro-bind ${approved} ${approved}`), wrapped);
  assert.doesNotMatch(wrapped, new RegExp(`--bind ${approved} ${approved}`));
});

test("shell-quoted bwrap deny mounts remain after a parent grant", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-space-grant-"));
  roots.push(root);
  const approved = join(root, "approved space");
  const protectedChild = join(approved, "protected");
  mkdirSync(protectedChild, { recursive: true });
  const wrapped = applyExecutionGrants(
    `bwrap --ro-bind / / --ro-bind /dev/null '${protectedChild}' -- bash -c true`,
    [{ root: approved, mode: "read-write" }],
    root,
    [],
    [],
  );
  assert.ok(
    wrapped.lastIndexOf(`--ro-bind /dev/null '${protectedChild}'`) >
      wrapped.indexOf(`--bind '${approved}' '${approved}'`),
    wrapped,
  );
});

test("a quoted bwrap path containing the separator text does not hide the real separator", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-separator-grant-"));
  roots.push(root);
  const approved = join(root, "approved -- archived");
  const protectedChild = join(approved, "protected");
  mkdirSync(protectedChild, { recursive: true });
  const wrapped = applyExecutionGrants(
    `bwrap --ro-bind / / --ro-bind /dev/null '${protectedChild}' -- bash -c true`,
    [{ root: approved, mode: "read-write" }],
    root,
    [],
    [],
  );
  assert.ok(
    wrapped.lastIndexOf(`--ro-bind /dev/null '${protectedChild}'`) >
      wrapped.indexOf(`--bind '${approved}' '${approved}'`),
    wrapped,
  );
});

test("macOS profiles append an exact read exception and retain protections", () => {
  const command =
    "env sandbox-exec -p '(version 1)\\n(deny file-read* (subpath \\\"/home\\\"))' /bin/bash -c true";
  const wrapped = applyMacReadGrants(
    command,
    [{ root: "/home/project", mode: "read" }],
    "/",
    ["/home/project/protected"],
    "darwin",
  );
  assert.ok(
    wrapped.includes('(allow file-read* (subpath "/home/project"))'),
    wrapped,
  );
  assert.ok(
    wrapped.includes('(deny file-read* (subpath "/home/project/protected"))'),
    wrapped,
  );
  assert.ok(
    wrapped.includes(
      '(deny file-write* (subpath "/home/project/.git/config"))',
    ),
    wrapped,
  );
  const globProtected = applyMacReadGrants(
    command,
    [{ root: "/home/project", mode: "read" }],
    "/",
    ["/home/project/*.pem"],
    "darwin",
  );
  assert.ok(
    globProtected.includes(
      '(deny file-read* (regex "^/home/project/[^/]*\\\\.pem$"))',
    ),
    globProtected,
  );
  const configuredVisible = applyMacReadGrants(command, [], "/", [], "darwin", [
    "/home/project",
  ]);
  assert.ok(
    configuredVisible.includes('(allow file-read* (subpath "/home/project"))'),
    configuredVisible,
  );
});

test("configured grants are consumed by direct tools without widening siblings", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-folder-grant-"));
  roots.push(root);
  const approved = join(root, "approved");
  const sibling = join(root, "sibling");
  mkdirSync(approved);
  mkdirSync(sibling);
  const policy = {
    denyRead: [root],
    denyWrite: [root],
    grants: [{ root: approved, mode: "read" as const }],
  };
  assert.equal(
    sandboxPathReason("read", join(approved, "file"), root, policy),
    undefined,
  );
  assert.match(
    sandboxPathReason("write", join(approved, "file"), root, policy) ?? "",
    /protected/,
  );
  assert.match(
    sandboxPathReason("read", join(sibling, "file"), root, policy) ?? "",
    /denyRead/,
  );
});

test("an explicit empty write allowlist denies direct writes", () => {
  assert.match(
    sandboxPathReason("write", "/tmp/file", "/", { allowWrite: [] }) ?? "",
    /allowWrite/,
  );
});

test("an omitted search path is treated as the current directory", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-implicit-search-"));
  roots.push(root);
  assert.match(
    sandboxPathReason("grep", ".", root, { denyRead: [root] }) ?? "",
    /denyRead/,
  );
});

test("a relative allowRead entry is bound at its path under the cwd", () => {
  const bound = applyAllowRead(
    `bwrap --ro-bind / / --tmpfs ${homedir()} --ro-bind /tmp /tmp -- bash -c true`,
    { allowRead: ["."] },
  );
  assert.ok(
    bound.includes(`--ro-bind ${process.cwd()} ${process.cwd()} `),
    bound,
  );
});

/** A launch script shaped like the runtime's, with its `\@` quoting of pnpm paths. */
function launched(applier: string, filter: string, prelude = ""): string {
  const quote = (path: string) => path.replace(/@/g, "\\\\@");
  return `-- /usr/bin/bash -c "${prelude}${quote(applier)} ${quote(filter)} /usr/bin/bash -c \\"true\\""`;
}

function launchFiles(): { applier: string; filter: string } {
  const root = mkdtempSync(join(tmpdir(), "pi-launch-"));
  roots.push(root);
  const vendor = join(root, "@anthropic-ai+sandbox-runtime@0.0.26", "x64");
  mkdirSync(vendor, { recursive: true });
  const applier = join(vendor, "apply-seccomp");
  const filter = join(vendor, "unix-block.bpf");
  writeFileSync(applier, "");
  writeFileSync(filter, "");
  return { applier, filter };
}

test("the launch files are read off the runtime's launch script", () => {
  const { applier, filter } = launchFiles();
  const socat =
    'socat TCP-LISTEN:3128,fork,reuseaddr UNIX-CONNECT:/tmp/h.sock >/dev/null 2>&1 &\ntrap \\"kill %1 %2 2>/dev/null; exit\\" EXIT\n';
  assert.deepEqual(
    bootstrapAssets(`bwrap --ro-bind / / ${launched(applier, filter, socat)}`),
    [applier, filter],
  );
  assert.deepEqual(
    bootstrapAssets(`bwrap --ro-bind / / -- /usr/bin/bash -c "eval 'true'"`),
    [],
  );
});

test("a hidden home keeps the launch files visible behind its tmpfs", () => {
  const { applier, filter } = launchFiles();
  const bound = applyAllowRead(
    `bwrap --ro-bind / / --ro-bind /tmp /tmp --tmpfs ${homedir()} --dev /dev ${launched(applier, filter)}`,
    { allowRead: [] },
  );
  const tmpfs = bound.indexOf(`--tmpfs ${homedir()} `);
  const applierBind = bound.indexOf(`--ro-bind ${applier} ${applier} `);
  const filterBind = bound.indexOf(`--ro-bind ${filter} ${filter} `);
  assert.ok(tmpfs !== -1 && applierBind > tmpfs && filterBind > tmpfs, bound);
  assert.ok(filterBind < bound.indexOf("--ro-bind /tmp /tmp"), bound);
});

test("launch files inside an allowRead root need no bind of their own", () => {
  const { applier, filter } = launchFiles();
  const bound = applyAllowRead(
    `bwrap --ro-bind / / --tmpfs ${homedir()} --dev /dev ${launched(applier, filter)}`,
    { allowRead: [dirname(applier)] },
  );
  assert.doesNotMatch(bound, /apply-seccomp \S*apply-seccomp/);
});

test("a grant does not re-append the launch-file binds after a deny", () => {
  const { applier, filter } = launchFiles();
  const root = mkdtempSync(join(tmpdir(), "pi-launch-grant-"));
  roots.push(root);
  const approved = join(root, "approved");
  mkdirSync(approved);
  const wrapped = applyExecutionGrants(
    `bwrap --ro-bind / / --ro-bind '${applier}' '${applier}' --tmpfs '${dirname(applier)}' ${launched(applier, filter)}`,
    [{ root: approved, mode: "read" }],
    root,
    [],
    [],
  );
  const applierBinds = wrapped.match(
    new RegExp(
      `--ro-bind '?${applier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}'? `,
      "g",
    ),
  );
  assert.equal(applierBinds?.length, 1, wrapped);
});

test.after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});
