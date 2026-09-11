import assert from "node:assert/strict";
import test from "node:test";
import type { AgentConfig } from "./agents.ts";
import {
  executeSingleAgent,
  getFinalOutput,
  getResultOutput,
  isFailedResult,
  type ExecutionChild,
  type ProcessHost,
} from "./execution.ts";

const agent: AgentConfig = {
  name: "worker",
  description: "test worker",
  source: "project",
  filePath: "/agents/worker.md",
  systemPrompt: "Follow the task.",
  mcpServers: { helper: { command: "helper" } },
};

class FakeChild implements ExecutionChild {
  #onEvent: ((event: Record<string, unknown>) => void) | undefined;
  #onStderr: ((text: string) => void) | undefined;
  #resolveExit!: (code: number) => void;
  #exit = new Promise<number>((resolve) => {
    this.#resolveExit = resolve;
  });
  terminated = false;
  startedTask: string | undefined;

  onEvent(listener: (event: Record<string, unknown>) => void): void {
    this.#onEvent = listener;
  }

  onStderr(listener: (text: string) => void): void {
    this.#onStderr = listener;
  }

  async start(task: string): Promise<void> {
    this.startedTask = task;
  }

  waitForExit(): Promise<number> {
    return this.#exit;
  }

  terminate(_signal: NodeJS.Signals): void {
    this.terminated = true;
  }

  isKilled(): boolean {
    return this.terminated;
  }

  emit(event: Record<string, unknown>): void {
    this.#onEvent?.(event);
  }

  stderr(text: string): void {
    this.#onStderr?.(text);
  }

  exit(code: number): void {
    this.#resolveExit(code);
  }
}

class FakeHost implements ProcessHost {
  readonly child = new FakeChild();
  readonly temporaryFiles: Array<{ prefix: string; name: string; content: string }> = [];
  readonly removed: string[] = [];
  spawnOptions:
    | { args: string[]; cwd: string; parentSessionId: string }
    | undefined;

  async createTempFile(prefix: string, name: string, content: string) {
    const temp = { dir: `/tmp/${this.temporaryFiles.length}`, filePath: `/tmp/${name}` };
    this.temporaryFiles.push({ prefix, name, content });
    return temp;
  }

  removeTemp(temp: { dir: string; filePath: string }): void {
    this.removed.push(temp.filePath);
  }

  resolveCwd(defaultCwd: string, cwd: string | undefined): string {
    return `${defaultCwd}/${cwd ?? "."}`;
  }

  spawn(options: { args: string[]; cwd: string; parentSessionId: string }): ExecutionChild {
    this.spawnOptions = options;
    return this.child;
  }
}

function request(host: ProcessHost, signal?: AbortSignal) {
  return executeSingleAgent({
    defaultCwd: "/project",
    dispatchDefaults: { model: "provider/default", thinkingLevel: "high" },
    agents: [agent],
    agentName: agent.name,
    task: "do the work",
    cwd: "nested",
    parentSessionId: "parent-session",
    signal,
    host,
    makeDetails: (results) => ({ mode: "single", projectAgentsDir: null, results }),
  });
}

test("execution host receives the configured child invocation and events become result updates", async () => {
  const host = new FakeHost();
  const updates: string[] = [];
  const running = executeSingleAgent({
    defaultCwd: "/project",
    dispatchDefaults: { model: "provider/default", thinkingLevel: "high" },
    agents: [agent],
    agentName: agent.name,
    task: "do the work",
    cwd: "nested",
    parentSessionId: "parent-session",
    host,
    onUpdate: (update) => updates.push((update.content[0] as { text: string }).text),
    makeDetails: (results) => ({ mode: "single", projectAgentsDir: null, results }),
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(host.spawnOptions, {
    args: [
      "--mode",
      "rpc",
      "--no-session",
      "-a",
      "--model",
      "provider/default",
      "--thinking",
      "high",
      "--append-system-prompt",
      "/tmp/prompt-worker.md",
      "--mcp-config",
      "/tmp/mcp-worker.json",
    ],
    cwd: "/project/nested",
    parentSessionId: "parent-session",
  });
  assert.equal(host.child.startedTask, "do the work");
  assert.deepEqual(host.temporaryFiles.map((file) => file.content), [
    "Follow the task.",
    JSON.stringify(
      { mcpServers: { helper: { command: "helper", lifecycle: "eager" } } },
      null,
      2,
    ),
  ]);

  host.child.stderr("child warning");
  host.child.emit({
    type: "message_end",
    message: {
      role: "assistant",
      model: "provider/child",
      stopReason: "end",
      usage: { input: 10, output: 4, cacheRead: 2, cacheWrite: 1, totalTokens: 20, cost: { total: 0.25 } },
      content: [{ type: "text", text: "finished" }],
    },
  });
  host.child.exit(0);

  const result = await running;
  assert.equal(result.stderr, "child warning");
  assert.equal(result.model, "provider/default");
  assert.equal(result.usage.turns, 1);
  assert.equal(result.usage.cost, 0.25);
  assert.deepEqual(updates, ["finished"]);
  assert.deepEqual(host.removed, ["/tmp/prompt-worker.md", "/tmp/mcp-worker.json"]);
});

test("aborting execution terminates the child and cleans up temporary resources", async () => {
  const host = new FakeHost();
  const controller = new AbortController();
  const running = request(host, controller.signal);

  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  assert.equal(host.child.terminated, true);
  host.child.exit(143);

  const result = await running;
  assert.equal(result.stopReason, "aborted");
  assert.deepEqual(host.removed, ["/tmp/prompt-worker.md", "/tmp/mcp-worker.json"]);
});

test("an aborted run returns the work accumulated before the abort", async () => {
  const host = new FakeHost();
  const controller = new AbortController();
  const running = request(host, controller.signal);

  await new Promise((resolve) => setImmediate(resolve));
  host.child.emit({
    type: "message_end",
    message: {
      role: "assistant",
      model: "provider/child",
      stopReason: "end",
      usage: {
        input: 30,
        output: 12,
        cacheRead: 3,
        cacheWrite: 1,
        totalTokens: 46,
        cost: { total: 0.5 },
      },
      content: [{ type: "text", text: "partial progress" }],
    },
  });
  controller.abort();
  host.child.exit(143);

  const result = await running;
  assert.equal(result.stopReason, "aborted");
  assert.equal(isFailedResult(result), true);
  assert.equal(result.exitCode, 143);
  assert.equal(result.messages.length, 1);
  assert.equal(getFinalOutput(result.messages), "partial progress");
  assert.equal(result.usage.turns, 1);
  assert.equal(result.usage.input, 30);
  assert.equal(result.usage.output, 12);
  assert.equal(result.usage.cost, 0.5);
  assert.equal(getResultOutput(result), "partial progress");
});

test("unknown agents return an equivalent error result without starting a child", async () => {
  const host = new FakeHost();
  const result = await executeSingleAgent({
    defaultCwd: "/project",
    dispatchDefaults: {},
    agents: [],
    agentName: "missing",
    task: "do the work",
    parentSessionId: "parent-session",
    host,
    makeDetails: (results) => ({ mode: "single", projectAgentsDir: null, results }),
  });

  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /Unknown agent: "missing"/);
  assert.equal(host.spawnOptions, undefined);
});
