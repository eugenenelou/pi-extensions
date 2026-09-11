import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  INHERITED_POLICY_ENV,
  type EffectivePolicy,
  type PermissionGlobals,
} from "./authorization.ts";
import sandboxExtension from "./index.ts";

test("cancelling a filesystem approval cannot mutate conversation authority", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-filesystem-cancel-"));
  const tools = new Map<string, any>();
  const handlers = new Map<string, (...args: any[]) => any>();
  let answer!: (choice: string) => void;
  let asked = false;
  const selected = new Promise<string>((resolve) => {
    answer = resolve;
  });
  const policy: EffectivePolicy = {
    version: 1,
    sandbox: { enabled: false, filesystem: {} },
    filesystem: {},
    permissions: {},
    tools: ["read"],
    toolMode: "inherited",
    grants: [],
    exactReads: [],
  };
  const previous = process.env[INHERITED_POLICY_ENV];
  process.env[INHERITED_POLICY_ENV] = JSON.stringify(policy);
  const pi = {
    registerFlag: () => {},
    registerCommand: () => {},
    registerTool: (tool: { name: string }) => tools.set(tool.name, tool),
    getFlag: () => false,
    getActiveTools: () => ["read"],
    on: (name: string, handler: (...args: any[]) => any) =>
      handlers.set(name, handler),
  } as unknown as ExtensionAPI;
  sandboxExtension(pi);
  const ctx = {
    cwd: root,
    mode: "tui",
    hasUI: true,
    sessionManager: {
      getSessionId: () => "session",
      getBranch: () => [],
      buildContextEntries: () => [],
    },
    ui: {
      theme: { fg: (_color: string, text: string) => text },
      notify: () => {},
      setStatus: () => {},
      select: async () => {
        asked = true;
        return selected;
      },
    },
  } as unknown as ExtensionContext;

  try {
    await handlers.get("session_start")?.({}, ctx);
    const broker = (globalThis as PermissionGlobals).__codassPermissionBroker!;
    const before = broker.snapshot();
    const controller = new AbortController();
    const requestTool = tools.get("request_filesystem_access");
    const running = requestTool.execute(
      "request-1",
      { path: root, access: "read-write", reason: "test cancellation" },
      controller.signal,
      undefined,
      ctx,
    );
    while (!asked) await new Promise((resolve) => setImmediate(resolve));
    controller.abort();
    answer("Allow for this conversation");
    const result = await running;
    const after = broker.snapshot();
    assert.equal(result.details.approved, false);
    assert.deepEqual(after.grants, before.grants);
    assert.deepEqual(after.exactReads, before.exactReads);
  } finally {
    await handlers.get("session_shutdown")?.({}, ctx);
    if (previous === undefined) delete process.env[INHERITED_POLICY_ENV];
    else process.env[INHERITED_POLICY_ENV] = previous;
    rmSync(root, { recursive: true, force: true });
  }
});
