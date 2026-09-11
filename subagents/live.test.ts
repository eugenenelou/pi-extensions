/**
 * Runtime integration probe for a live delegated child, without a model call:
 *   node --experimental-strip-types --test subagents/live.test.ts
 */

import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { EventEmitter, once } from "node:events";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import type { AgentConfig } from "./agents.ts";
import type { EffectivePolicy } from "../sandbox/authorization.ts";
import { runSingleAgent } from "./index.ts";
import { LiveChild } from "./live.ts";

type WireClient = {
  socket: net.Socket;
  next(): Promise<Record<string, unknown>>;
  send(value: Record<string, unknown>): void;
  close(): void;
};

async function connect(port: number): Promise<WireClient> {
  const socket = net.createConnection({ host: "127.0.0.1", port });
  await once(socket, "connect");
  let buffer = "";
  const pending: Array<(value: Record<string, unknown>) => void> = [];
  const received: Record<string, unknown>[] = [];
  socket.on("data", (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line) continue;
      const value = JSON.parse(line) as Record<string, unknown>;
      const resolve = pending.shift();
      if (resolve) resolve(value);
      else received.push(value);
    }
  });
  return {
    socket,
    next: () =>
      new Promise((resolve) => {
        const value = received.shift();
        if (value) resolve(value);
        else pending.push(resolve);
      }),
    send: (value) => socket.write(`${JSON.stringify(value)}\n`),
    close: () => socket.destroy(),
  };
}

async function waitFor<T>(get: () => T | undefined): Promise<T> {
  for (let i = 0; i < 100; i++) {
    const value = get();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for controlled child");
}

function splitInsideEmoji(value: Record<string, unknown>): [Buffer, Buffer] {
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`);
  const splitAt = bytes.indexOf(Buffer.from("😀")) + 1;
  assert.ok(splitAt > 0);
  return [bytes.subarray(0, splitAt), bytes.subarray(splitAt)];
}

function liveServerSocket(port: number, clientPort: number): net.Socket | undefined {
  const handles = (
    process as NodeJS.Process & { _getActiveHandles(): unknown[] }
  )._getActiveHandles();
  return handles.find(
    (handle): handle is net.Socket =>
      handle instanceof net.Socket &&
      handle.localPort === port &&
      handle.remotePort === clientPort,
  );
}

test("child RPC output preserves a multibyte character split across chunks", () => {
  const stdout = new PassThrough();
  const proc = Object.assign(new EventEmitter(), {
    stdout,
    stdin: new PassThrough(),
    killed: false,
    kill: () => true,
  }) as unknown as ChildProcess;
  const events: Record<string, unknown>[] = [];
  const live = new LiveChild(proc, "parent-session", process.cwd(), (event) =>
    events.push(event),
  );
  const expected = {
    type: "message_end",
    message: { role: "assistant", content: "before 😀 after" },
  };
  const [first, second] = splitInsideEmoji(expected);

  stdout.write(first);
  assert.deepEqual(events, []);
  stdout.write(second);
  assert.deepEqual(events, [expected]);
  live.dispose();
});

test("a child exit cancels its outstanding forwarded approval", async () => {
  const stdout = new PassThrough();
  const stdin = new PassThrough();
  const proc = Object.assign(new EventEmitter(), {
    stdout,
    stdin,
    stderr: new PassThrough(),
    killed: false,
    kill: () => true,
  }) as unknown as ChildProcess;
  let requestSignal: AbortSignal | undefined;
  const live = new LiveChild(
    proc,
    "parent-session",
    process.cwd(),
    () => {},
    async (_request, signal) => {
      requestSignal = signal;
      await new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      );
      return { type: "extension_ui_response", id: "ui-exit", value: "Allow" };
    },
  );

  stdout.write(`${JSON.stringify({
    type: "extension_ui_request",
    id: "ui-exit",
    method: "select",
    title: "Permission",
    options: ["Allow", "Cancel"],
  })}\n`);
  await waitFor(() => requestSignal);
  proc.emit("close", 0);
  await waitFor(() => requestSignal?.aborted ? true : undefined);
  assert.equal(requestSignal?.aborted, true);
  assert.equal(stdin.readableLength, 0, "a stale approval response was written");
  live.dispose();
});

test("a launched child is observed and steered through its one runtime", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-live-child-"));
  const registryDir = path.join(root, "registry");
  const otherCwd = path.join(root, "other-cwd");
  const starts = path.join(root, "starts");
  fs.mkdirSync(otherCwd);
  const childScript = path.join(root, "controlled-child.mjs");
  fs.writeFileSync(
    childScript,
    `import readline from "node:readline";
import { appendFileSync } from "node:fs";
appendFileSync(process.env.CONTROLLED_STARTS, "started\\n");
const out = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
process.stderr.write(JSON.stringify({ type: "codass_policy_ready", ready: true }) + "\\n");
const sessionId = process.env.PI_SUBAGENT_PARENT_SESSION_ID === "child-session" ? "grandchild-session" : "child-session";
let prompted = false;
const initialEvents = () => {
  out({ type: "agent_start" });
  out({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "initial output" }] } });
  out({ type: "tool_execution_start", toolCallId: "tool-1", toolName: "controlled", args: {} });
  out({ type: "tool_execution_end", toolCallId: "tool-1", toolName: "controlled", result: { content: [{ type: "text", text: "tool output" }] }, isError: false });
};
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const command = JSON.parse(line);
  if (command.type === "extension_ui_response" && command.id === "ui-1") {
    appendFileSync(process.env.CONTROLLED_STARTS, "ui:" + String(command.cancelled) + "\\n");
    initialEvents();
    return;
  }
  if (command.type === "get_state") {
    out({ type: "response", id: command.id, command: "get_state", success: true, data: { sessionId } });
    return;
  }
  if (command.type !== "prompt") return;
  out({ type: "response", id: command.id, command: "prompt", success: true });
  if (command.message === "Task: exit immediately") {
    out({ type: "agent_settled" });
    return;
  }
  if (!prompted) {
    prompted = true;
    out({ type: "extension_ui_request", id: "ui-1", method: "select", title: "Permission", options: ["Allow", "Cancel"] });
    return;
  }
  out({ type: "message_end", message: { role: "user", content: command.message } });
  out({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "influenced output" }] } });
  out({ type: "agent_settled" });
});
`,
  );

  const originalArgv = process.argv[1];
  const originalRegistry = process.env.PI_SUBAGENT_REGISTRY_DIR;
  const originalStarts = process.env.CONTROLLED_STARTS;
  process.argv[1] = childScript;
  process.env.PI_SUBAGENT_REGISTRY_DIR = registryDir;
  process.env.CONTROLLED_STARTS = starts;

  const effectivePolicy: EffectivePolicy = {
    version: 1,
    sandbox: { enabled: true, filesystem: {} },
    filesystem: {},
    permissions: {},
    tools: ["read"],
    grants: [],
    exactReads: [],
  };
  const permission = {
    effectivePolicy,
    authorizeDelegation: async () => undefined,
    validateDelegation: () => true,
    onUiRequest: async (request: { id: string }) => ({
      type: "extension_ui_response" as const,
      id: request.id,
      cancelled: true,
    }),
  };
  const agent: AgentConfig = {
    name: "controlled",
    description: "controlled runtime child",
    source: "user",
    filePath: childScript,
    systemPrompt: "",
  };
  try {
    const result = runSingleAgent(
      root,
      {},
      [agent],
      agent.name,
      "original task",
      path.basename(otherCwd),
      undefined,
      "parent-session",
      undefined,
      undefined,
      () => ({ mode: "single", projectAgentsDir: null, results: [] }),
      permission,
    );

    const registryFile = await waitFor(() => {
      try {
        return fs
          .readdirSync(registryDir)
          .find((file) => file.endsWith(".json"));
      } catch {
        return undefined;
      }
    });
    const record = JSON.parse(
      fs.readFileSync(path.join(registryDir, registryFile), "utf-8"),
    ) as Record<string, unknown>;
    assert.equal(record.sessionId, "child-session");
    assert.equal(record.parentSessionId, "parent-session");
    assert.equal(record.cwd, otherCwd);

    const grandchild = runSingleAgent(
      root,
      {},
      [agent],
      agent.name,
      "grandchild task",
      root,
      undefined,
      "child-session",
      undefined,
      undefined,
      () => ({ mode: "single", projectAgentsDir: null, results: [] }),
      permission,
    );
    const grandchildFile = await waitFor(() => {
      try {
        return fs
          .readdirSync(registryDir)
          .find((file) => file.endsWith(".json") && file !== registryFile);
      } catch {
        return undefined;
      }
    });
    const grandchildRecord = JSON.parse(
      fs.readFileSync(path.join(registryDir, grandchildFile), "utf-8"),
    ) as Record<string, unknown>;
    assert.equal(grandchildRecord.sessionId, "grandchild-session");
    assert.equal(grandchildRecord.parentSessionId, "child-session");
    assert.equal(grandchildRecord.cwd, root);

    const port = record.port as number;
    const client = await connect(port);
    client.send({ type: "observe" });
    const snapshot = await client.next();
    assert.equal(snapshot.type, "snapshot");
    assert.match(JSON.stringify(snapshot), /initial output/);
    assert.match(JSON.stringify(snapshot), /tool output/);

    const serverSocket = await waitFor(() =>
      liveServerSocket(port, client.socket.localPort!),
    );
    const [first, second] = splitInsideEmoji({
      type: "message",
      id: "message-1",
      text: "before 😀 after",
    });
    const bytesRead = serverSocket.bytesRead;
    client.socket.write(first);
    await waitFor(() =>
      serverSocket.bytesRead >= bytesRead + first.length ? true : undefined,
    );
    client.socket.write(second);

    let sawInfluencedOutput = false;
    let sawUtf8ClientMessage = false;
    let sawMessageResponse = false;
    for (;;) {
      const update = await client.next();
      if (JSON.stringify(update).includes("influenced output"))
        sawInfluencedOutput = true;
      if (JSON.stringify(update).includes('"content":"before 😀 after"'))
        sawUtf8ClientMessage = true;
      if (update.type === "response" && update.id === "message-1") {
        assert.equal(update.success, true);
        sawMessageResponse = true;
      }
      if (update.type === "closed") break;
    }
    assert.equal(sawMessageResponse, true);
    assert.equal(sawInfluencedOutput, true);
    client.send({ type: "message", id: "after-exit", text: "too late" });
    assert.deepEqual(await client.next(), {
      type: "response",
      id: "after-exit",
      success: false,
      error: "Child is no longer running.",
    });

    const grandchildClient = await connect(grandchildRecord.port as number);
    grandchildClient.send({
      type: "message",
      id: "grandchild-exit",
      text: "finish",
    });
    for (;;) {
      const update = await grandchildClient.next();
      if (update.type === "closed") break;
    }

    const completed = await result;
    await grandchild;
    const exitedDuringStartup = await runSingleAgent(
      root,
      {},
      [agent],
      agent.name,
      "exit immediately",
      root,
      undefined,
      "parent-session",
      undefined,
      undefined,
      () => ({ mode: "single", projectAgentsDir: null, results: [] }),
      permission,
    );
    client.close();
    grandchildClient.close();
    assert.equal(completed.exitCode, 0);
    assert.equal(exitedDuringStartup.exitCode, 0);
    assert.equal(
      completed.messages.filter((message) => message.role === "assistant")
        .length,
      2,
    );
    assert.equal(
      fs.readFileSync(starts, "utf-8"),
      "started\nui:true\nstarted\nui:true\nstarted\n",
    );
    assert.equal(fs.existsSync(path.join(registryDir, registryFile)), false);
    assert.equal(fs.existsSync(path.join(registryDir, grandchildFile)), false);
    assert.deepEqual(fs.readdirSync(registryDir), []);
    assert.equal(sawUtf8ClientMessage, true);
  } finally {
    process.argv[1] = originalArgv;
    if (originalRegistry === undefined)
      delete process.env.PI_SUBAGENT_REGISTRY_DIR;
    else process.env.PI_SUBAGENT_REGISTRY_DIR = originalRegistry;
    if (originalStarts === undefined) delete process.env.CONTROLLED_STARTS;
    else process.env.CONTROLLED_STARTS = originalStarts;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
