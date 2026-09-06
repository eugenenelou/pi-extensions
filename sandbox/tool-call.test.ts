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
import { join } from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { applyAllowRead, sandboxPathReason } from "./index.ts";

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

test.after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});
