import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  INHERITED_POLICY_ENV,
  makeDelegationRequest,
  type EffectivePolicy,
  type PermissionGlobals,
} from "./authorization.ts";
import sandboxExtension from "./index.ts";

function extensionHarness(root: string, inherited: EffectivePolicy) {
  const tools = new Map<string, any>();
  const handlers = new Map<string, (...args: any[]) => any>();
  const choices: Array<string | undefined> = [];
  let selectCount = 0;
  process.env[INHERITED_POLICY_ENV] = JSON.stringify(inherited);
  const pi = {
    registerFlag: () => {},
    registerCommand: () => {},
    registerTool: (tool: { name: string }) => tools.set(tool.name, tool),
    getFlag: () => false,
    getActiveTools: () => ["read", "bash", "subagent"],
    on: (name: string, handler: (...args: any[]) => any) => handlers.set(name, handler),
  } as unknown as ExtensionAPI;
  sandboxExtension(pi);
  const ctx = {
    cwd: root,
    mode: "rpc",
    hasUI: true,
    sessionManager: {
      getSessionId: () => "parent-session",
      getBranch: () => [],
      buildContextEntries: () => [],
    },
    ui: {
      theme: { fg: (_color: string, text: string) => text },
      notify: () => {},
      setStatus: () => {},
      select: async () => {
        selectCount += 1;
        return choices.shift();
      },
    },
  } as unknown as ExtensionContext;
  return {
    handlers,
    ctx,
    choices,
    selectCount: () => selectCount,
    broker: () => (globalThis as PermissionGlobals).__codassPermissionBroker!,
  };
}

test("the production broker keeps run grants inactive and remembers only matching session extent", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-broker-parent-"));
  const target = mkdtempSync(join(tmpdir(), "pi-broker-target-"));
  const targetModeRoot = mkdtempSync(join(tmpdir(), "pi-broker-target-mode-"));
  const agentDir = join(root, "agent");
  mkdirSync(join(agentDir, "extensions"), { recursive: true });
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const previousPolicy = process.env[INHERITED_POLICY_ENV];
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const inherited: EffectivePolicy = {
    version: 1,
    sandbox: { enabled: false, filesystem: { denyRead: [target], allowWrite: [root] } },
    filesystem: { denyRead: [target], allowWrite: [root] },
    permissions: { allow: ["read", "subagent"] },
    tools: ["read", "subagent"],
    toolMode: "inherited",
    grants: [],
    exactReads: [],
  };
  const h = extensionHarness(root, inherited);
  try {
    await h.handlers.get("session_start")?.({}, h.ctx);
    const request = makeDelegationRequest("worker", target, "read", "directory", "target");

    h.choices.push("Directory access · this run");
    const run = await h.broker().authorizeDelegation(request);
    assert.equal(run?.decision.duration, "run");
    assert.deepEqual(h.broker().snapshot().grants, []);
    assert.equal(h.broker().snapshot().delegationApprovals, undefined);

    h.choices.push("Directory access · remember for session");
    const remembered = await h.broker().authorizeDelegation(request);
    assert.equal(remembered?.decision.duration, "session");
    assert.deepEqual(h.broker().snapshot().grants, []);
    assert.equal(h.broker().snapshot().delegationApprovals?.length, 1);

    const matched = await h.broker().authorizeDelegation(request);
    assert.equal(matched?.decision.duration, "session");
    assert.equal(h.selectCount(), 2, "matching remembered extent prompted again");

    h.choices.push(undefined);
    const broader = await h.broker().authorizeDelegation({ ...request, access: "read-write" });
    assert.equal(broader, undefined);
    assert.equal(h.selectCount(), 3);

    h.choices.push("Target project permissions · this run");
    const targetMode = await h.broker().authorizeDelegation({
      ...request,
      target: targetModeRoot,
    });
    assert.equal(targetMode?.policy.toolMode, "target-project");
    assert.equal(targetMode?.projectTrusted, true);
    assert.equal(
      Boolean(targetMode?.policy.permissions.allow?.includes("subagent")),
      false,
      "target mode retained a parent-only command permission",
    );
    assert.deepEqual(targetMode?.policy.exactReads, []);
  } finally {
    await h.handlers.get("session_shutdown")?.({}, h.ctx);
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    if (previousPolicy === undefined) delete process.env[INHERITED_POLICY_ENV];
    else process.env[INHERITED_POLICY_ENV] = previousPolicy;
    rmSync(root, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
    rmSync(targetModeRoot, { recursive: true, force: true });
  }
});

test("only interactive explicit at-file references mint exact read provenance", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-broker-attachment-"));
  const agentDir = join(root, "agent");
  const attached = join(root, "attached.txt");
  mkdirSync(join(agentDir, "extensions"), { recursive: true });
  writeFileSync(attached, "attached");
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const previousPolicy = process.env[INHERITED_POLICY_ENV];
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const inherited: EffectivePolicy = {
    version: 1,
    sandbox: { enabled: false, filesystem: {} },
    filesystem: {},
    permissions: {},
    tools: ["read"],
    toolMode: "inherited",
    grants: [],
    exactReads: [],
  };
  const h = extensionHarness(root, inherited);
  try {
    await h.handlers.get("session_start")?.({}, h.ctx);
    const input = h.handlers.get("input")!;
    input({ source: "rpc", text: `read @${attached}` }, h.ctx);
    input({ source: "interactive", text: `quoted \"@${attached}\"` }, h.ctx);
    assert.deepEqual(h.broker().snapshot().exactReads, []);
    input({ source: "interactive", text: `read @${attached}` }, h.ctx);
    assert.deepEqual(h.broker().snapshot().exactReads, [{ path: attached }]);
  } finally {
    await h.handlers.get("session_shutdown")?.({}, h.ctx);
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    if (previousPolicy === undefined) delete process.env[INHERITED_POLICY_ENV];
    else process.env[INHERITED_POLICY_ENV] = previousPolicy;
    rmSync(root, { recursive: true, force: true });
  }
});
