import type { AgentToolResult, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import type { AgentConfig, McpServers } from "./agents.ts";
import { NO_HUMAN_ENV } from "../sandbox/permissions.ts";
import { nodeProcessHost, type ExecutionChild, type ProcessHost } from "./process-host.ts";

const PER_TASK_OUTPUT_CAP = 50 * 1024;

export interface UsageStats {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  contextTokens: number;
  turns: number;
}

export interface SingleResult {
  agent: string;
  agentSource: "builtin" | "user" | "project" | "unknown";
  task: string;
  exitCode: number;
  messages: Message[];
  stderr: string;
  usage: UsageStats;
  model?: string;
  thinking?: string;
  stopReason?: string;
  errorMessage?: string;
  step?: number;
}

export interface SubagentDetails {
  mode: "single" | "parallel" | "chain";
  projectAgentsDir: string | null;
  results: SingleResult[];
}

export interface DispatchDefaults {
  model?: string;
  thinkingLevel?: ThinkingLevel;
}

export type OnUpdateCallback = (partial: AgentToolResult<SubagentDetails>) => void;

export interface SingleExecutionRequest {
  defaultCwd: string;
  dispatchDefaults: DispatchDefaults;
  agents: AgentConfig[];
  agentName: string;
  task: string;
  cwd?: string;
  step?: number;
  parentSessionId: string;
  signal?: AbortSignal;
  onUpdate?: OnUpdateCallback;
  makeDetails: (results: SingleResult[]) => SubagentDetails;
  host?: ProcessHost;
}

export { type ExecutionChild, type ProcessHost } from "./process-host.ts";

function emptyUsage(): UsageStats {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    contextTokens: 0,
    turns: 0,
  };
}

export function getFinalOutput(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === "assistant") {
      for (const part of msg.content) {
        if (part.type === "text") return part.text;
      }
    }
  }
  return "";
}

export function isFailedResult(result: SingleResult): boolean {
  return (
    result.exitCode !== 0 ||
    result.stopReason === "error" ||
    result.stopReason === "aborted"
  );
}

export function getResultOutput(result: SingleResult): string {
  if (isFailedResult(result)) {
    return (
      result.errorMessage ||
      result.stderr ||
      getFinalOutput(result.messages) ||
      "(no output)"
    );
  }
  return getFinalOutput(result.messages) || "(no output)";
}

export function truncateOutput(output: string): string {
  const byteLength = Buffer.byteLength(output, "utf8");
  if (byteLength <= PER_TASK_OUTPUT_CAP) return output;

  let truncated = output.slice(0, PER_TASK_OUTPUT_CAP);
  while (Buffer.byteLength(truncated, "utf8") > PER_TASK_OUTPUT_CAP)
    truncated = truncated.slice(0, -1);
  return `${truncated}\n\n[Output truncated: ${byteLength - Buffer.byteLength(truncated, "utf8")} bytes omitted. Full output preserved in tool details.]`;
}

function withEagerLifecycle(servers: McpServers): McpServers {
  return Object.fromEntries(
    Object.entries(servers).map(([name, entry]) => [
      name,
      entry.lifecycle ? entry : { ...entry, lifecycle: "eager" },
    ]),
  );
}

/**
 * Executes one delegated child through the host boundary. The tool adapter owns
 * mode orchestration; this seam owns one process's configuration, event
 * translation, cancellation, and temporary resources.
 */
export async function executeSingleAgent({
  defaultCwd,
  dispatchDefaults,
  agents,
  agentName,
  task,
  cwd,
  step,
  parentSessionId,
  signal,
  onUpdate,
  makeDetails,
  host = nodeProcessHost,
}: SingleExecutionRequest): Promise<SingleResult> {
  const agent = agents.find((candidate) => candidate.name === agentName);

  if (!agent) {
    const available = agents.map((candidate) => `"${candidate.name}"`).join(", ") || "none";
    return {
      agent: agentName,
      agentSource: "unknown",
      task,
      exitCode: 1,
      messages: [],
      stderr: `Unknown agent: "${agentName}". Available agents: ${available}.`,
      usage: emptyUsage(),
      step,
    };
  }

  const args: string[] = ["--mode", "rpc", "--no-session", "-a"];
  const model = agent.model ?? dispatchDefaults.model;
  if (model) args.push("--model", model);
  const thinking =
    agent.thinking ??
    (agent.model ? undefined : dispatchDefaults.thinkingLevel);
  if (thinking) args.push("--thinking", thinking);
  if (agent.tools && agent.tools.length > 0)
    args.push("--tools", agent.tools.join(","));

  let tmpPrompt: { dir: string; filePath: string } | undefined;
  let tmpMcp: { dir: string; filePath: string } | undefined;
  let child: ExecutionChild | undefined;
  let wasAborted = false;

  const currentResult: SingleResult = {
    agent: agentName,
    agentSource: agent.source,
    task,
    exitCode: 0,
    messages: [],
    stderr: "",
    usage: emptyUsage(),
    model,
    thinking,
    step,
  };

  const emitUpdate = () => {
    onUpdate?.({
      content: [
        {
          type: "text",
          text: getFinalOutput(currentResult.messages) || "(running...)",
        },
      ],
      details: makeDetails([currentResult]),
    });
  };

  try {
    if (agent.systemPrompt.trim()) {
      tmpPrompt = await host.createTempFile(
        "pi-subagent-",
        `prompt-${agent.name}.md`,
        agent.systemPrompt,
      );
      args.push("--append-system-prompt", tmpPrompt.filePath);
    }

    if (agent.mcpServers) {
      tmpMcp = await host.createTempFile(
        "pi-subagent-mcp-",
        `mcp-${agent.name}.json`,
        JSON.stringify(
          { mcpServers: withEagerLifecycle(agent.mcpServers) },
          null,
          2,
        ),
      );
      args.push("--mcp-config", tmpMcp.filePath);
    }

    child = host.spawn({
      args,
      cwd: host.resolveCwd(defaultCwd, cwd),
      parentSessionId,
      env: { [NO_HUMAN_ENV]: "1" },
    });
    child.onEvent((event) => {
      if (event.type !== "message_end" || !event.message) return;
      const message = event.message as Message;
      currentResult.messages.push(message);
      if (message.role === "assistant") {
        currentResult.usage.turns++;
        const usage = message.usage;
        if (usage) {
          currentResult.usage.input += usage.input || 0;
          currentResult.usage.output += usage.output || 0;
          currentResult.usage.cacheRead += usage.cacheRead || 0;
          currentResult.usage.cacheWrite += usage.cacheWrite || 0;
          currentResult.usage.cost += usage.cost?.total || 0;
          currentResult.usage.contextTokens = usage.totalTokens || 0;
        }
        if (!currentResult.model && message.model) currentResult.model = message.model;
        if (message.stopReason) currentResult.stopReason = message.stopReason;
        if (message.errorMessage) currentResult.errorMessage = message.errorMessage;
      }
      emitUpdate();
    });
    child.onStderr((text) => {
      currentResult.stderr += text;
    });

    const abortChild = () => {
      wasAborted = true;
      child?.terminate("SIGTERM");
      setTimeout(() => {
        if (child && !child.isKilled()) child.terminate("SIGKILL");
      }, 5000).unref();
    };
    if (signal) {
      if (signal.aborted) abortChild();
      else signal.addEventListener("abort", abortChild, { once: true });
    }

    try {
      await child.start(task);
    } catch (error) {
      child.terminate("SIGTERM");
      throw error;
    }
    currentResult.exitCode = await child.waitForExit();
    if (wasAborted) currentResult.stopReason = "aborted";
    return currentResult;
  } finally {
    if (tmpPrompt) host.removeTemp(tmpPrompt);
    if (tmpMcp) host.removeTemp(tmpMcp);
  }
}
