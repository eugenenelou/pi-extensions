import type { AgentToolResult, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import type { AgentConfig } from "./agents.ts";
import { FilesystemPolicy, resolveFilesystemPath } from "../sandbox/filesystem-policy.ts";
import {
  INHERITED_POLICY_ENV,
  MAX_INHERITED_POLICY_BYTES,
  makeDelegationRequest,
  type DelegationAuthorization,
  type EffectivePolicy,
} from "../sandbox/authorization.ts";
import type { ExtensionUiRequest, ExtensionUiResponse } from "./live.ts";
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
  access?: "read" | "read-write";
  step?: number;
  parentSessionId: string;
  signal?: AbortSignal;
  onUpdate?: OnUpdateCallback;
  makeDetails: (results: SingleResult[]) => SubagentDetails;
  effectivePolicy?: EffectivePolicy;
  authorizeDelegation?: (
    request: ReturnType<typeof makeDelegationRequest>,
    signal?: AbortSignal,
  ) => Promise<DelegationAuthorization | undefined>;
  validateDelegation?: (
    target: string,
    access: "read" | "read-write",
    authorization: DelegationAuthorization,
  ) => boolean;
  onUiRequest?: (
    request: ExtensionUiRequest,
    signal: AbortSignal,
  ) => Promise<ExtensionUiResponse>;
  /** Trusted user-installed extensions required to enforce and re-delegate. */
  inheritedExtensionPaths?: string[];
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
  access = "read-write",
  step,
  parentSessionId,
  signal,
  onUpdate,
  makeDetails,
  effectivePolicy,
  authorizeDelegation,
  validateDelegation,
  onUiRequest,
  inheritedExtensionPaths = [],
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

  let targetCwd: string;
  try {
    targetCwd = resolveFilesystemPath(host.resolveCwd(defaultCwd, cwd));
  } catch {
    targetCwd = host.resolveCwd(defaultCwd, cwd);
  }
  const abortedResult = (): SingleResult => ({
    agent: agentName,
    agentSource: agent.source,
    task,
    exitCode: 1,
    messages: [],
    stderr: "Delegation cancelled before the child started.",
    usage: emptyUsage(),
    stopReason: "aborted",
    step,
  });
  if (signal?.aborted) return abortedResult();

  let authorization: DelegationAuthorization | undefined;
  if (effectivePolicy) {
    const policy = new FilesystemPolicy(
      effectivePolicy.filesystem,
      targetCwd,
      effectivePolicy.grants,
      process.platform,
      effectivePolicy.exactReads,
    );
    // Delegation needs access to adopt this cwd, not blanket permission to
    // traverse protected descendants; those restrictions remain in the child.
    const read = policy.evaluate("read", targetCwd).state === "allowed";
    const write = access === "read" || policy.evaluate("write", targetCwd).state === "allowed";
    if (read && write) {
      authorization = {
        decision: { permission: "directory", duration: "run" },
        policy: effectivePolicy,
        projectTrusted: false,
      };
    } else if (authorizeDelegation) {
      authorization = await authorizeDelegation(
        makeDelegationRequest(
          agentName,
          targetCwd,
          access,
          `Keeps inherited restrictions and adds ${access} access only to ${targetCwd}.`,
          `Replaces inherited permissions with the normal policy loaded from ${targetCwd}; it may grant access beyond that directory.`,
        ),
        signal,
      );
    }
  }
  if (signal?.aborted) return abortedResult();
  if (
    !authorization ||
    (validateDelegation &&
      !validateDelegation(targetCwd, access, authorization))
  ) {
    return {
      agent: agentName,
      agentSource: agent.source,
      task,
      exitCode: 1,
      messages: [],
      stderr: `Delegation permission refused for ${targetCwd}.`,
      usage: emptyUsage(),
      step,
    };
  }

  if (signal?.aborted) return abortedResult();
  const serializedPolicy = JSON.stringify(authorization.policy);
  if (Buffer.byteLength(serializedPolicy, "utf8") > MAX_INHERITED_POLICY_BYTES) {
    return {
      agent: agentName,
      agentSource: agent.source,
      task,
      exitCode: 1,
      messages: [],
      stderr: "Delegated permission policy is too large to hand off safely.",
      usage: emptyUsage(),
      step,
    };
  }

  const args: string[] = ["--mode", "rpc", "--no-session"];
  if (authorization.policy.toolMode !== "target-project") {
    args.push("--no-approve");
  }
  for (const extension of inheritedExtensionPaths) {
    args.push("--extension", extension);
  }
  const model = agent.model ?? dispatchDefaults.model;
  if (model) args.push("--model", model);
  const thinking =
    agent.thinking ??
    (agent.model ? undefined : dispatchDefaults.thinkingLevel);
  if (thinking) args.push("--thinking", thinking);
  if (authorization.policy.toolMode === "target-project") {
    // No CLI override: after explicit target-mode approval Pi loads exactly
    // the active tool set of a directly opened session in that project. An
    // agent file from the parent cannot activate or suppress target tools.
  } else {
    const requestedTools = agent.tools ?? authorization.policy.tools;
    const tools = requestedTools.filter((tool) => authorization.policy.tools.includes(tool));
    if (tools.length > 0) args.push("--tools", tools.join(","));
    else args.push("--no-tools");
  }

  let tmpPrompt: { dir: string; filePath: string } | undefined;
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

    if (signal?.aborted) return abortedResult();
    child = host.spawn({
      args,
      cwd: targetCwd,
      parentSessionId,
      env: { [INHERITED_POLICY_ENV]: serializedPolicy },
      onUiRequest: onUiRequest
        ? (request, requestSignal) =>
            onUiRequest(
              {
                ...request,
                codassRequester: agentName,
                codassTargetCwd: targetCwd,
                codassParentSessionId: parentSessionId,
              },
              requestSignal,
            )
        : undefined,
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

    const terminateChild = () => {
      child?.terminate("SIGTERM");
      setTimeout(() => {
        if (child && !child.hasExited()) child.terminate("SIGKILL");
      }, 5000).unref();
    };
    const abortChild = () => {
      wasAborted = true;
      terminateChild();
    };
    if (signal) {
      if (signal.aborted) abortChild();
      else signal.addEventListener("abort", abortChild, { once: true });
    }

    try {
      await child.start(task);
    } catch (error) {
      signal?.removeEventListener("abort", abortChild);
      terminateChild();
      throw error;
    }
    currentResult.exitCode = await child.waitForExit();
    signal?.removeEventListener("abort", abortChild);
    if (wasAborted) currentResult.stopReason = "aborted";
    return currentResult;
  } finally {
    if (tmpPrompt) host.removeTemp(tmpPrompt);
  }
}
