import assert from "node:assert/strict";
import test from "node:test";
import { INHERITED_POLICY_ENV, type EffectivePolicy } from "../sandbox/authorization.ts";
import type { AgentConfig } from "./agents.ts";
import {
  executeSingleAgent,
  getFinalOutput,
  getResultOutput,
  isFailedResult,
  type ExecutionChild,
  type ProcessHost,
} from "./execution.ts";

const effectivePolicy: EffectivePolicy = {
  version: 1,
  sandbox: { enabled: true, filesystem: {} },
  filesystem: {},
  permissions: {},
  tools: ["read", "bash"],
  grants: [],
  exactReads: [],
};

const agent: AgentConfig = {
  name: "worker",
  description: "test worker",
  source: "project",
  filePath: "/agents/worker.md",
  systemPrompt: "Follow the task.",
};

class FakeChild implements ExecutionChild {
  #onEvent: ((event: Record<string, unknown>) => void) | undefined;
  #onStderr: ((text: string) => void) | undefined;
  #resolveExit!: (code: number) => void;
  #exit = new Promise<number>((resolve) => {
    this.#resolveExit = resolve;
  });
  terminated = false;
  exited = false;
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

  hasExited(): boolean {
    return this.exited;
  }

  emit(event: Record<string, unknown>): void {
    this.#onEvent?.(event);
  }

  stderr(text: string): void {
    this.#onStderr?.(text);
  }

  exit(code: number): void {
    this.exited = true;
    this.#resolveExit(code);
  }
}

class FakeHost implements ProcessHost {
  readonly child = new FakeChild();
  readonly temporaryFiles: Array<{ prefix: string; name: string; content: string }> = [];
  readonly removed: string[] = [];
  spawnOptions:
    | { args: string[]; cwd: string; parentSessionId: string; env?: Record<string, string> }
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
    return cwd?.startsWith("/") ? cwd : `${defaultCwd}/${cwd ?? "."}`;
  }

  spawn(options: { args: string[]; cwd: string; parentSessionId: string; env?: Record<string, string> }): ExecutionChild {
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
    effectivePolicy,
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
    effectivePolicy,
    onUpdate: (update) => updates.push((update.content[0] as { text: string }).text),
    makeDetails: (results) => ({ mode: "single", projectAgentsDir: null, results }),
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(host.spawnOptions, {
    args: [
      "--mode",
      "rpc",
      "--no-session",
      "--no-approve",
      "--model",
      "provider/default",
      "--thinking",
      "high",
      "--tools",
      "read,bash",
      "--append-system-prompt",
      "/tmp/prompt-worker.md",
    ],
    cwd: "/project/nested",
    parentSessionId: "parent-session",
    env: { [INHERITED_POLICY_ENV]: JSON.stringify(effectivePolicy) },
    onUiRequest: undefined,
  });
  assert.equal(host.child.startedTask, "do the work");
  assert.deepEqual(host.temporaryFiles.map((file) => file.content), [
    "Follow the task.",
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
  assert.deepEqual(host.removed, ["/tmp/prompt-worker.md"]);
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
  assert.deepEqual(host.removed, ["/tmp/prompt-worker.md"]);
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

test("delegation outside inherited scope is refused before spawn without authorization", async () => {
  const host = new FakeHost();
  const restricted: EffectivePolicy = {
    ...effectivePolicy,
    filesystem: { denyRead: ["/"], allowWrite: ["/project"] },
    sandbox: { enabled: true, filesystem: { denyRead: ["/"], allowWrite: ["/project"] } },
  };
  const result = await executeSingleAgent({
    defaultCwd: "/project",
    dispatchDefaults: {},
    agents: [agent],
    agentName: agent.name,
    task: "outside",
    cwd: "/other",
    parentSessionId: "parent",
    host,
    effectivePolicy: restricted,
    makeDetails: (results) => ({ mode: "single", projectAgentsDir: null, results }),
  });
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /permission refused/);
  assert.equal(host.spawnOptions, undefined);
});

test("approved target-project mode replaces the inherited policy and enables project resources", async () => {
  const host = new FakeHost();
  const restricted: EffectivePolicy = {
    ...effectivePolicy,
    filesystem: { denyRead: ["/other"], allowWrite: ["/project"] },
  };
  const target: EffectivePolicy = {
    ...effectivePolicy,
    filesystem: { allowWrite: ["/other"] },
    permissions: { allow: ["bash(target-only:*)"] },
    toolMode: "target-project",
    targetProjectRoot: "/other",
    projectResourcesFingerprint: "approved-resources",
  };
  let requested: unknown;
  const running = executeSingleAgent({
    defaultCwd: "/project",
    dispatchDefaults: {},
    agents: [{ ...agent, tools: ["read"] }],
    agentName: agent.name,
    task: "outside",
    cwd: "/other",
    parentSessionId: "parent",
    host,
    effectivePolicy: restricted,
    authorizeDelegation: async (request) => {
      requested = request;
      return {
        decision: { permission: "target-project", duration: "run" },
        policy: target,
        projectTrusted: true,
      };
    },
    makeDetails: (results) => ({ mode: "single", projectAgentsDir: null, results }),
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((requested as { target: string }).target, "/other");
  assert.equal((requested as { access: string }).access, "read-write");
  assert.equal(host.spawnOptions?.args.includes("--approve"), false);
  assert.equal(host.spawnOptions?.args.includes("--no-approve"), false);
  assert.equal(host.spawnOptions?.args.includes("--tools"), false);
  assert.deepEqual(
    JSON.parse(host.spawnOptions?.env?.[INHERITED_POLICY_ENV] ?? "null"),
    target,
  );
  host.child.exit(0);
  await running;
});

test("cancelling a pending launch approval prevents every child spawn", async () => {
  const host = new FakeHost();
  const controller = new AbortController();
  const restricted: EffectivePolicy = {
    ...effectivePolicy,
    filesystem: { denyRead: ["/"], allowWrite: ["/project"] },
  };
  let answer!: (authorization: {
    decision: { permission: "directory"; duration: "run" };
    policy: EffectivePolicy;
    projectTrusted: false;
  }) => void;
  const approval = new Promise<Parameters<typeof answer>[0]>((resolve) => {
    answer = resolve;
  });
  const running = executeSingleAgent({
    defaultCwd: "/project",
    dispatchDefaults: {},
    agents: [agent],
    agentName: agent.name,
    task: "outside",
    cwd: "/other",
    parentSessionId: "parent",
    signal: controller.signal,
    host,
    effectivePolicy: restricted,
    authorizeDelegation: async () => approval,
    validateDelegation: () => true,
    makeDetails: (results) => ({ mode: "single", projectAgentsDir: null, results }),
  });
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  answer({
    decision: { permission: "directory", duration: "run" },
    policy: effectivePolicy,
    projectTrusted: false,
  });
  const result = await running;
  assert.equal(result.stopReason, "aborted");
  assert.equal(host.spawnOptions, undefined);
});

test("an invalid delegated authorization is refused before spawn", async () => {
  const host = new FakeHost();
  let validated: { target: string; access: string } | undefined;
  const restricted: EffectivePolicy = {
    ...effectivePolicy,
    filesystem: { denyRead: ["/"], allowWrite: ["/project"] },
  };
  const result = await executeSingleAgent({
    defaultCwd: "/project",
    dispatchDefaults: {},
    agents: [agent],
    agentName: agent.name,
    task: "outside",
    cwd: "/other",
    parentSessionId: "parent",
    host,
    effectivePolicy: restricted,
    authorizeDelegation: async () => ({
      decision: { permission: "directory", duration: "run" },
      policy: effectivePolicy,
      projectTrusted: false,
    }),
    validateDelegation: (target, access) => {
      validated = { target, access };
      return false;
    },
    makeDetails: (results) => ({ mode: "single", projectAgentsDir: null, results }),
  });
  assert.equal(result.exitCode, 1);
  assert.deepEqual(validated, { target: "/other", access: "read-write" });
  assert.equal(host.spawnOptions, undefined);
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
