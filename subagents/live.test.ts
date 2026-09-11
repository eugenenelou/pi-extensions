/**
 * Runtime integration probe for a live delegated child, without a model call:
 *   node --experimental-strip-types --test subagents/live.test.ts
 */

import assert from "node:assert/strict";
import { once } from "node:events";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import type { AgentConfig } from "./agents.ts";
import { runSingleAgent } from "./index.ts";

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
const sessionId = process.env.PI_SUBAGENT_PARENT_SESSION_ID === "child-session" ? "grandchild-session" : "child-session";
let prompted = false;
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const command = JSON.parse(line);
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
    out({ type: "agent_start" });
    out({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "initial output" }] } });
    out({ type: "tool_execution_start", toolCallId: "tool-1", toolName: "controlled", args: {} });
    out({ type: "tool_execution_end", toolCallId: "tool-1", toolName: "controlled", result: { content: [{ type: "text", text: "tool output" }] }, isError: false });
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
    );

    const registryFile = await waitFor(() => {
      try {
        return fs.readdirSync(registryDir).find((file) => file.endsWith(".json"));
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

    const client = await connect(record.port as number);
    client.send({ type: "observe" });
    const snapshot = await client.next();
    assert.equal(snapshot.type, "snapshot");
    assert.match(JSON.stringify(snapshot), /initial output/);
    assert.match(JSON.stringify(snapshot), /tool output/);

    client.send({ type: "message", id: "message-1", text: "change direction" });
    assert.deepEqual(await client.next(), {
      type: "response",
      id: "message-1",
      success: true,
    });
    let sawInfluencedOutput = false;
    for (;;) {
      const update = await client.next();
      if (JSON.stringify(update).includes("influenced output"))
        sawInfluencedOutput = true;
      if (update.type === "closed") break;
    }
    assert.equal(sawInfluencedOutput, true);
    client.send({ type: "message", id: "after-exit", text: "too late" });
    assert.deepEqual(await client.next(), {
      type: "response",
      id: "after-exit",
      success: false,
      error: "Child is no longer running.",
    });

    const grandchildClient = await connect(grandchildRecord.port as number);
    grandchildClient.send({ type: "message", id: "grandchild-exit", text: "finish" });
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
    );
    client.close();
    grandchildClient.close();
    assert.equal(completed.exitCode, 0);
    assert.equal(exitedDuringStartup.exitCode, 0);
    assert.equal(
      completed.messages.filter((message) => message.role === "assistant").length,
      2,
    );
    assert.equal(
      fs.readFileSync(starts, "utf-8"),
      "started\nstarted\nstarted\n",
    );
    assert.equal(fs.existsSync(path.join(registryDir, registryFile)), false);
    assert.equal(fs.existsSync(path.join(registryDir, grandchildFile)), false);
    assert.deepEqual(fs.readdirSync(registryDir), []);
  } finally {
    process.argv[1] = originalArgv;
    if (originalRegistry === undefined) delete process.env.PI_SUBAGENT_REGISTRY_DIR;
    else process.env.PI_SUBAGENT_REGISTRY_DIR = originalRegistry;
    if (originalStarts === undefined) delete process.env.CONTROLLED_STARTS;
    else process.env.CONTROLLED_STARTS = originalStarts;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
