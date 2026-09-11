/**
 * Subagent tool - delegate tasks to specialized agents.
 *
 * Spawns a separate RPC-mode Pi process per invocation, giving each subagent
 * an isolated context window. Modes: single, parallel, chain (`{previous}`).
 *
 * Trusted CLI extensions install the inherited policy before the task starts.
 * Project resources stay disabled unless target-project permissions were
 * explicitly approved; the same handoff lets descendants delegate safely.
 *
 * Repo-controlled agent frontmatter cannot start inline servers or otherwise
 * expand the effective policy handed down by the parent.
 */

import * as os from "node:os";
import { fileURLToPath } from "node:url";
import type {
  AgentToolResult,
  ThinkingLevel,
} from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import {
  type ExtensionAPI,
  getMarkdownTheme,
} from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import {
  DEFAULT_AGENT_NAME,
  type AgentConfig,
  discoverAgents,
} from "./agents.ts";
import {
  executeSingleAgent,
  getFinalOutput,
  getResultOutput,
  isFailedResult,
  truncateOutput,
  type DispatchDefaults,
  type OnUpdateCallback,
  type SingleResult,
  type SubagentDetails,
} from "./execution.ts";
import type { PermissionGlobals } from "../sandbox/authorization.ts";
import {
  DelegationApprovalDialog,
  type DelegationApprovalDecision,
  type DelegationApprovalRequest,
} from "./approval-dialog.ts";
import type { ExtensionUiRequest, ExtensionUiResponse } from "./live.ts";

const TRUSTED_CHILD_EXTENSIONS = [
  fileURLToPath(import.meta.url),
  fileURLToPath(new URL("../sandbox/index.ts", import.meta.url)),
];

const MAX_PARALLEL_TASKS = 8;
const MAX_CONCURRENCY = 4;
const COLLAPSED_ITEM_COUNT = 10;

function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  return `${(count / 1000000).toFixed(1)}M`;
}

function formatUsageStats(
  usage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    cost: number;
    contextTokens?: number;
    turns?: number;
  },
  model?: string,
  thinking?: string,
): string {
  const parts: string[] = [];
  if (usage.turns)
    parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
  if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
  if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
  if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
  if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
  if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
  if (usage.contextTokens && usage.contextTokens > 0)
    parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
  if (model) parts.push(thinking ? `${model}:${thinking}` : model);
  return parts.join(" ");
}

function formatToolCall(
  toolName: string,
  args: Record<string, unknown>,
  themeFg: (color: any, text: string) => string,
): string {
  const shortenPath = (p: string) => {
    const home = os.homedir();
    return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
  };

  switch (toolName) {
    case "bash": {
      const command = (args.command as string) || "...";
      const preview =
        command.length > 60 ? `${command.slice(0, 60)}...` : command;
      return themeFg("muted", "$ ") + themeFg("toolOutput", preview);
    }
    case "read": {
      const filePath = shortenPath(
        (args.file_path || args.path || "...") as string,
      );
      const offset = args.offset as number | undefined;
      const limit = args.limit as number | undefined;
      let text = themeFg("accent", filePath);
      if (offset !== undefined || limit !== undefined) {
        const startLine = offset ?? 1;
        const endLine = limit !== undefined ? startLine + limit - 1 : "";
        text += themeFg(
          "warning",
          `:${startLine}${endLine ? `-${endLine}` : ""}`,
        );
      }
      return themeFg("muted", "read ") + text;
    }
    case "write": {
      const filePath = shortenPath(
        (args.file_path || args.path || "...") as string,
      );
      const lines = ((args.content || "") as string).split("\n").length;
      let text = themeFg("muted", "write ") + themeFg("accent", filePath);
      if (lines > 1) text += themeFg("dim", ` (${lines} lines)`);
      return text;
    }
    case "edit":
      return (
        themeFg("muted", "edit ") +
        themeFg(
          "accent",
          shortenPath((args.file_path || args.path || "...") as string),
        )
      );
    case "ls":
      return (
        themeFg("muted", "ls ") +
        themeFg("accent", shortenPath((args.path || ".") as string))
      );
    case "find":
      return (
        themeFg("muted", "find ") +
        themeFg("accent", (args.pattern || "*") as string) +
        themeFg("dim", ` in ${shortenPath((args.path || ".") as string)}`)
      );
    case "grep":
      return (
        themeFg("muted", "grep ") +
        themeFg("accent", `/${(args.pattern || "") as string}/`) +
        themeFg("dim", ` in ${shortenPath((args.path || ".") as string)}`)
      );
    default: {
      const argsStr = JSON.stringify(args);
      const preview =
        argsStr.length > 50 ? `${argsStr.slice(0, 50)}...` : argsStr;
      return themeFg("accent", toolName) + themeFg("dim", ` ${preview}`);
    }
  }
}

async function mapWithConcurrencyLimit<TIn, TOut>(
  items: TIn[],
  concurrency: number,
  fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
  if (items.length === 0) return [];
  const limit = Math.max(1, Math.min(concurrency, items.length));
  const results: TOut[] = new Array(items.length);
  let nextIndex = 0;
  const workers = new Array(limit).fill(null).map(async () => {
    while (true) {
      const current = nextIndex++;
      if (current >= items.length) return;
      results[current] = await fn(items[current], current);
    }
  });
  await Promise.all(workers);
  return results;
}

type DisplayItem =
  | { type: "text"; text: string }
  | { type: "toolCall"; name: string; args: Record<string, any> };

function getDisplayItems(messages: Message[]): DisplayItem[] {
  const items: DisplayItem[] = [];
  for (const msg of messages) {
    if (msg.role === "assistant") {
      for (const part of msg.content) {
        if (part.type === "text") items.push({ type: "text", text: part.text });
        else if (part.type === "toolCall")
          items.push({
            type: "toolCall",
            name: part.name,
            args: part.arguments,
          });
      }
    }
  }
  return items;
}

export async function runSingleAgent(
  defaultCwd: string,
  dispatchDefaults: DispatchDefaults,
  agents: AgentConfig[],
  agentName: string,
  task: string,
  cwd: string | undefined,
  step: number | undefined,
  parentSessionId: string,
  signal: AbortSignal | undefined,
  onUpdate: OnUpdateCallback | undefined,
  makeDetails: (results: SingleResult[]) => SubagentDetails,
  permission?: {
    effectivePolicy: ReturnType<NonNullable<PermissionGlobals["__codassPermissionBroker"]>["snapshot"]>;
    authorizeDelegation: NonNullable<PermissionGlobals["__codassPermissionBroker"]>["authorizeDelegation"];
    validateDelegation: NonNullable<PermissionGlobals["__codassPermissionBroker"]>["validateDelegation"];
    onUiRequest: (
      request: ExtensionUiRequest,
      signal: AbortSignal,
    ) => Promise<ExtensionUiResponse>;
  },
  access: "read" | "read-write" = "read-write",
): Promise<SingleResult> {
  return executeSingleAgent({
    defaultCwd,
    dispatchDefaults,
    agents,
    agentName,
    task,
    cwd,
    access,
    step,
    parentSessionId,
    signal,
    onUpdate,
    makeDetails,
    effectivePolicy: permission?.effectivePolicy,
    authorizeDelegation: permission?.authorizeDelegation,
    validateDelegation: permission?.validateDelegation,
    onUiRequest: permission?.onUiRequest,
    inheritedExtensionPaths: TRUSTED_CHILD_EXTENSIONS,
  });
}

const TaskItem = Type.Object({
  agent: Type.String({ description: "Name of the agent to invoke" }),
  task: Type.String({ description: "Task to delegate to the agent" }),
  cwd: Type.Optional(
    Type.String({ description: "Working directory for the agent process" }),
  ),
  access: Type.Optional(StringEnum(["read", "read-write"] as const, {
    description: "Filesystem access requested at cwd (default: read-write)",
  })),
});

const ChainItem = Type.Object({
  agent: Type.String({ description: "Name of the agent to invoke" }),
  task: Type.String({
    description: "Task with optional {previous} placeholder for prior output",
  }),
  cwd: Type.Optional(
    Type.String({ description: "Working directory for the agent process" }),
  ),
  access: Type.Optional(StringEnum(["read", "read-write"] as const, {
    description: "Filesystem access requested at cwd (default: read-write)",
  })),
});

const SubagentParams = Type.Object({
  agent: Type.Optional(
    Type.String({
      description: "Name of the agent to invoke (for single mode)",
    }),
  ),
  task: Type.Optional(
    Type.String({ description: "Task to delegate (for single mode)" }),
  ),
  tasks: Type.Optional(
    Type.Array(TaskItem, {
      description: "Array of {agent, task} for parallel execution",
    }),
  ),
  chain: Type.Optional(
    Type.Array(ChainItem, {
      description: "Array of {agent, task} for sequential execution",
    }),
  ),
  cwd: Type.Optional(
    Type.String({
      description: "Working directory for the agent process (single mode)",
    }),
  ),
  access: Type.Optional(StringEnum(["read", "read-write"] as const, {
    description: "Filesystem access requested at cwd (single mode; default: read-write)",
  })),
});

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description: [
      "Delegate tasks to subagents, each with its own isolated context and model.",
      "Modes: single (task, with optional agent), parallel (tasks array), chain (sequential with {previous} placeholder). An omitted single-mode agent uses the built-in default agent.",
      "Agents are defined in .pi/agents/*.md (project) and ~/.pi/agent/agents/*.md (user).",
    ].join(" "),
    parameters: SubagentParams,

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      params.agent ??= DEFAULT_AGENT_NAME;

      const dispatchDefaults: DispatchDefaults = {
        model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
        thinkingLevel: ctx.thinkingLevel,
      };
      const discovery = discoverAgents(ctx.cwd);
      const agents = discovery.agents;
      const broker = (globalThis as PermissionGlobals).__codassPermissionBroker;
      const labelFor = (decision: DelegationApprovalDecision) =>
        decision.permission === "directory"
          ? decision.duration === "run" ? "Directory access · this run" : "Directory access · remember for session"
          : decision.duration === "run" ? "Target project permissions · this run" : "Target project permissions · remember for session";
      const onUiRequest = async (
        request: ExtensionUiRequest,
        signal: AbortSignal,
      ): Promise<ExtensionUiResponse> => {
        const cancelled = (): ExtensionUiResponse => ({
          type: "extension_ui_response",
          id: request.id,
          cancelled: true,
        });
        if (!ctx.hasUI || signal.aborted) return cancelled();
        if (request.method === "select" && typeof request.title === "string") {
          const prefix = "CODASS_DELEGATION_REQUEST ";
          if (request.title.startsWith(prefix) && ctx.mode === "tui") {
            try {
              const delegation = JSON.parse(request.title.slice(prefix.length)) as DelegationApprovalRequest;
              let dismiss: (() => void) | undefined;
              const decision = await ctx.ui.custom<DelegationApprovalDecision | undefined>((tui, _theme, _keys, done) => {
                let finished = false;
                const finish = (value: DelegationApprovalDecision | undefined) => {
                  if (finished) return;
                  finished = true;
                  done(value);
                };
                dismiss = () => finish(undefined);
                signal.addEventListener("abort", dismiss, { once: true });
                if (signal.aborted) finish(undefined);
                return new DelegationApprovalDialog(delegation, finish, () => tui.requestRender());
              });
              if (dismiss) signal.removeEventListener("abort", dismiss);
              return decision
                ? { type: "extension_ui_response", id: request.id, value: labelFor(decision) }
                : cancelled();
            } catch {
              return cancelled();
            }
          }
          const options = Array.isArray(request.options)
            ? request.options.filter((value): value is string => typeof value === "string")
            : [];
          const identity =
            typeof request.codassRequester === "string"
              ? `Subagent ${request.codassRequester}${
                  typeof request.codassTargetCwd === "string"
                    ? ` in ${request.codassTargetCwd}`
                    : ""
                }\n`
              : "";
          const value = await ctx.ui.select(
            request.title.startsWith(prefix)
              ? request.title
              : `${identity}${request.title}`,
            options,
            { signal },
          );
          return value === undefined ? cancelled() : {
            type: "extension_ui_response",
            id: request.id,
            value,
          };
        }
        const identity =
          typeof request.codassRequester === "string"
            ? `Subagent ${request.codassRequester}${
                typeof request.codassTargetCwd === "string"
                  ? ` in ${request.codassTargetCwd}`
                  : ""
              }\n`
            : "";
        if (request.method === "confirm") {
          const confirmed = await ctx.ui.confirm(
            `${identity}${String(request.title ?? "Permission request")}`,
            String(request.message ?? ""),
            { signal },
          );
          return signal.aborted ? cancelled() : {
            type: "extension_ui_response",
            id: request.id,
            confirmed,
          };
        }
        if (request.method === "input") {
          const value = await ctx.ui.input(
            `${identity}${String(request.title ?? "Permission request")}`,
            String(request.placeholder ?? ""),
            { signal },
          );
          return value === undefined || signal.aborted
            ? cancelled()
            : { type: "extension_ui_response", id: request.id, value };
        }
        // Pi's multi-line editor has no AbortSignal API. Do not leave a stale
        // user-facing dialog open after a descendant disappears.
        if (request.method === "editor") return cancelled();
        return cancelled();
      };
      const permission = broker ? {
        effectivePolicy: broker.snapshot(),
        authorizeDelegation: broker.authorizeDelegation.bind(broker),
        validateDelegation: broker.validateDelegation.bind(broker),
        onUiRequest,
      } : undefined;

      const hasChain = (params.chain?.length ?? 0) > 0;
      const hasTasks = (params.tasks?.length ?? 0) > 0;
      const hasSingle = Boolean(params.task);
      const modeCount = Number(hasChain) + Number(hasTasks) + Number(hasSingle);

      const makeDetails =
        (mode: "single" | "parallel" | "chain") =>
        (results: SingleResult[]): SubagentDetails => ({
          mode,
          projectAgentsDir: discovery.projectAgentsDir,
          results,
        });

      if (modeCount !== 1) {
        const available =
          agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
        return {
          content: [
            {
              type: "text",
              text: `Invalid parameters. Provide exactly one mode.\nAvailable agents: ${available}`,
            },
          ],
          details: makeDetails("single")([]),
        };
      }

      if (params.chain && params.chain.length > 0) {
        const results: SingleResult[] = [];
        let previousOutput = "";

        for (let i = 0; i < params.chain.length; i++) {
          const step = params.chain[i];
          const taskWithContext = step.task.replace(
            /\{previous\}/g,
            previousOutput,
          );

          const chainUpdate: OnUpdateCallback | undefined = onUpdate
            ? (partial) => {
                const currentResult = partial.details?.results[0];
                if (currentResult) {
                  onUpdate({
                    content: partial.content,
                    details: makeDetails("chain")([...results, currentResult]),
                  });
                }
              }
            : undefined;

          const agentName = step.agent;
          const result = await runSingleAgent(
            ctx.cwd,
            dispatchDefaults,
            agents,
            agentName,
            taskWithContext,
            step.cwd,
            i + 1,
            ctx.sessionManager.getSessionId(),
            signal,
            chainUpdate,
            makeDetails("chain"),
            permission,
            step.access,
          );
          results.push(result);

          if (isFailedResult(result)) {
            return {
              content: [
                {
                  type: "text",
                  text: `Chain stopped at step ${i + 1} (${agentName}): ${truncateOutput(getResultOutput(result))}`,
                },
              ],
              details: makeDetails("chain")(results),
              isError: true,
            };
          }
          previousOutput = getFinalOutput(result.messages);
        }
        return {
          content: [
            {
              type: "text",
              text: truncateOutput(
                getFinalOutput(results[results.length - 1].messages) ||
                  "(no output)",
              ),
            },
          ],
          details: makeDetails("chain")(results),
        };
      }

      if (params.tasks && params.tasks.length > 0) {
        if (params.tasks.length > MAX_PARALLEL_TASKS)
          return {
            content: [
              {
                type: "text",
                text: `Too many parallel tasks (${params.tasks.length}). Max is ${MAX_PARALLEL_TASKS}.`,
              },
            ],
            details: makeDetails("parallel")([]),
          };

        const allResults: SingleResult[] = params.tasks.map((t) => ({
          agent: t.agent,
          agentSource: "unknown",
          task: t.task,
          exitCode: -1,
          messages: [],
          stderr: "",
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            cost: 0,
            contextTokens: 0,
            turns: 0,
          },
        }));

        const emitParallelUpdate = () => {
          if (!onUpdate) return;
          const running = allResults.filter((r) => r.exitCode === -1).length;
          const done = allResults.length - running;
          onUpdate({
            content: [
              {
                type: "text",
                text: `Parallel: ${done}/${allResults.length} done, ${running} running...`,
              },
            ],
            details: makeDetails("parallel")([...allResults]),
          });
        };

        const results = await mapWithConcurrencyLimit(
          params.tasks,
          MAX_CONCURRENCY,
          async (t, index) => {
            const result = await runSingleAgent(
              ctx.cwd,
              dispatchDefaults,
              agents,
              t.agent,
              t.task,
              t.cwd,
              undefined,
              ctx.sessionManager.getSessionId(),
              signal,
              (partial) => {
                if (partial.details?.results[0]) {
                  allResults[index] = partial.details.results[0];
                  emitParallelUpdate();
                }
              },
              makeDetails("parallel"),
              permission,
              t.access,
            );
            allResults[index] = result;
            emitParallelUpdate();
            return result;
          },
        );

        const successCount = results.filter((r) => !isFailedResult(r)).length;
        const summaries = results.map((r) => {
          const status = isFailedResult(r)
            ? `failed${r.stopReason && r.stopReason !== "end" ? ` (${r.stopReason})` : ""}`
            : "completed";
          return `### [${r.agent}] ${status}\n\n${truncateOutput(getResultOutput(r))}`;
        });
        return {
          content: [
            {
              type: "text",
              text: `Parallel: ${successCount}/${results.length} succeeded\n\n${summaries.join("\n\n---\n\n")}`,
            },
          ],
          details: makeDetails("parallel")(results),
        };
      }

      const result = await runSingleAgent(
        ctx.cwd,
        dispatchDefaults,
        agents,
        params.agent,
        params.task as string,
        params.cwd,
        undefined,
        ctx.sessionManager.getSessionId(),
        signal,
        onUpdate,
        makeDetails("single"),
        permission,
        params.access,
      );
      if (isFailedResult(result)) {
        return {
          content: [
            {
              type: "text",
              text: `Agent ${result.stopReason || "failed"}: ${truncateOutput(getResultOutput(result))}`,
            },
          ],
          details: makeDetails("single")([result]),
          isError: true,
        };
      }
      return {
        content: [
          {
            type: "text",
            text: truncateOutput(
              getFinalOutput(result.messages) || "(no output)",
            ),
          },
        ],
        details: makeDetails("single")([result]),
      };
    },

    renderCall(args, theme, _context) {
      if (args.chain && args.chain.length > 0) {
        let text =
          theme.fg("toolTitle", theme.bold("subagent ")) +
          theme.fg("accent", `chain (${args.chain.length} steps)`);
        for (let i = 0; i < Math.min(args.chain.length, 3); i++) {
          const step = args.chain[i];
          const cleanTask = step.task.replace(/\{previous\}/g, "").trim();
          const preview =
            cleanTask.length > 40 ? `${cleanTask.slice(0, 40)}...` : cleanTask;
          text +=
            "\n  " +
            theme.fg("muted", `${i + 1}.`) +
            " " +
            theme.fg("accent", step.agent) +
            theme.fg("dim", ` ${preview}`);
        }
        if (args.chain.length > 3)
          text += `\n  ${theme.fg("muted", `... +${args.chain.length - 3} more`)}`;
        return new Text(text, 0, 0);
      }
      if (args.tasks && args.tasks.length > 0) {
        let text =
          theme.fg("toolTitle", theme.bold("subagent ")) +
          theme.fg("accent", `parallel (${args.tasks.length} tasks)`);
        for (const t of args.tasks.slice(0, 3)) {
          const preview =
            t.task.length > 40 ? `${t.task.slice(0, 40)}...` : t.task;
          text += `\n  ${theme.fg("accent", t.agent)}${theme.fg("dim", ` ${preview}`)}`;
        }
        if (args.tasks.length > 3)
          text += `\n  ${theme.fg("muted", `... +${args.tasks.length - 3} more`)}`;
        return new Text(text, 0, 0);
      }
      const preview = args.task
        ? args.task.length > 60
          ? `${args.task.slice(0, 60)}...`
          : args.task
        : "...";
      return new Text(
        `${theme.fg("toolTitle", theme.bold("subagent ")) + theme.fg("accent", args.agent || DEFAULT_AGENT_NAME)}\n  ${theme.fg("dim", preview)}`,
        0,
        0,
      );
    },

    renderResult(result, { expanded }, theme, _context) {
      const details = result.details as SubagentDetails | undefined;
      if (!details || details.results.length === 0) {
        const text = result.content[0];
        return new Text(
          text?.type === "text" ? text.text : "(no output)",
          0,
          0,
        );
      }

      const mdTheme = getMarkdownTheme();

      const renderDisplayItems = (items: DisplayItem[], limit?: number) => {
        const toShow = limit ? items.slice(-limit) : items;
        const skipped =
          limit && items.length > limit ? items.length - limit : 0;
        let text = "";
        if (skipped > 0)
          text += theme.fg("muted", `... ${skipped} earlier items\n`);
        for (const item of toShow) {
          if (item.type === "text") {
            const preview = expanded
              ? item.text
              : item.text.split("\n").slice(0, 3).join("\n");
            text += `${theme.fg("toolOutput", preview)}\n`;
          } else {
            text += `${theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme))}\n`;
          }
        }
        return text.trimEnd();
      };

      const aggregateUsage = (results: SingleResult[]) => {
        const total = {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          cost: 0,
          turns: 0,
        };
        for (const r of results) {
          total.input += r.usage.input;
          total.output += r.usage.output;
          total.cacheRead += r.usage.cacheRead;
          total.cacheWrite += r.usage.cacheWrite;
          total.cost += r.usage.cost;
          total.turns += r.usage.turns;
        }
        return total;
      };

      const appendResultBody = (container: Container, r: SingleResult) => {
        for (const item of getDisplayItems(r.messages)) {
          if (item.type === "toolCall") {
            container.addChild(
              new Text(
                theme.fg("muted", "→ ") +
                  formatToolCall(item.name, item.args, theme.fg.bind(theme)),
                0,
                0,
              ),
            );
          }
        }
        const finalOutput = getFinalOutput(r.messages);
        if (finalOutput) {
          container.addChild(new Spacer(1));
          container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
        }
      };

      if (details.mode === "single" && details.results.length === 1) {
        const r = details.results[0];
        const isError = isFailedResult(r);
        const icon = isError
          ? theme.fg("error", "✗")
          : theme.fg("success", "✓");
        const displayItems = getDisplayItems(r.messages);

        if (expanded) {
          const container = new Container();
          let header = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}`;
          if (isError && r.stopReason)
            header += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
          container.addChild(new Text(header, 0, 0));
          if (isError && r.errorMessage)
            container.addChild(
              new Text(theme.fg("error", `Error: ${r.errorMessage}`), 0, 0),
            );
          container.addChild(new Spacer(1));
          container.addChild(new Text(theme.fg("muted", "─── Task ───"), 0, 0));
          container.addChild(new Text(theme.fg("dim", r.task), 0, 0));
          container.addChild(new Spacer(1));
          container.addChild(
            new Text(theme.fg("muted", "─── Output ───"), 0, 0),
          );
          if (displayItems.length === 0 && !getFinalOutput(r.messages)) {
            container.addChild(
              new Text(theme.fg("muted", "(no output)"), 0, 0),
            );
          } else {
            appendResultBody(container, r);
          }
          const usageStr = formatUsageStats(r.usage, r.model, r.thinking);
          if (usageStr) {
            container.addChild(new Spacer(1));
            container.addChild(new Text(theme.fg("dim", usageStr), 0, 0));
          }
          return container;
        }

        let text = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}`;
        if (isError && r.stopReason)
          text += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
        if (isError && r.errorMessage)
          text += `\n${theme.fg("error", `Error: ${r.errorMessage}`)}`;
        else if (displayItems.length === 0)
          text += `\n${theme.fg("muted", "(no output)")}`;
        else {
          text += `\n${renderDisplayItems(displayItems, COLLAPSED_ITEM_COUNT)}`;
          if (displayItems.length > COLLAPSED_ITEM_COUNT)
            text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
        }
        const usageStr = formatUsageStats(r.usage, r.model, r.thinking);
        if (usageStr) text += `\n${theme.fg("dim", usageStr)}`;
        return new Text(text, 0, 0);
      }

      const isChain = details.mode === "chain";
      const running = details.results.filter((r) => r.exitCode === -1).length;
      const successCount = details.results.filter(
        (r) => r.exitCode !== -1 && !isFailedResult(r),
      ).length;
      const failCount = details.results.filter(
        (r) => r.exitCode !== -1 && isFailedResult(r),
      ).length;
      const icon =
        running > 0
          ? theme.fg("warning", "⏳")
          : failCount > 0
            ? theme.fg("warning", "◐")
            : theme.fg("success", "✓");
      const label = isChain ? "chain " : "parallel ";
      const status =
        running > 0
          ? `${successCount + failCount}/${details.results.length} done, ${running} running`
          : `${successCount}/${details.results.length} ${isChain ? "steps" : "tasks"}`;

      if (expanded && running === 0) {
        const container = new Container();
        container.addChild(
          new Text(
            `${icon} ${theme.fg("toolTitle", theme.bold(label))}${theme.fg("accent", status)}`,
            0,
            0,
          ),
        );
        for (const r of details.results) {
          const rIcon = isFailedResult(r)
            ? theme.fg("error", "✗")
            : theme.fg("success", "✓");
          container.addChild(new Spacer(1));
          const heading = isChain ? `─── Step ${r.step}: ` : "─── ";
          container.addChild(
            new Text(
              `${theme.fg("muted", heading) + theme.fg("accent", r.agent)} ${rIcon}`,
              0,
              0,
            ),
          );
          container.addChild(
            new Text(
              theme.fg("muted", "Task: ") + theme.fg("dim", r.task),
              0,
              0,
            ),
          );
          appendResultBody(container, r);
          const taskUsage = formatUsageStats(r.usage, r.model, r.thinking);
          if (taskUsage)
            container.addChild(new Text(theme.fg("dim", taskUsage), 0, 0));
        }
        const usageStr = formatUsageStats(aggregateUsage(details.results));
        if (usageStr) {
          container.addChild(new Spacer(1));
          container.addChild(
            new Text(theme.fg("dim", `Total: ${usageStr}`), 0, 0),
          );
        }
        return container;
      }

      let text = `${icon} ${theme.fg("toolTitle", theme.bold(label))}${theme.fg("accent", status)}`;
      for (const r of details.results) {
        const rIcon =
          r.exitCode === -1
            ? theme.fg("warning", "⏳")
            : isFailedResult(r)
              ? theme.fg("error", "✗")
              : theme.fg("success", "✓");
        const displayItems = getDisplayItems(r.messages);
        const heading = isChain ? `─── Step ${r.step}: ` : "─── ";
        text += `\n\n${theme.fg("muted", heading)}${theme.fg("accent", r.agent)} ${rIcon}`;
        if (displayItems.length === 0)
          text += `\n${theme.fg("muted", r.exitCode === -1 ? "(running...)" : "(no output)")}`;
        else text += `\n${renderDisplayItems(displayItems, 5)}`;
      }
      if (running === 0) {
        const usageStr = formatUsageStats(aggregateUsage(details.results));
        if (usageStr) text += `\n\n${theme.fg("dim", `Total: ${usageStr}`)}`;
      }
      text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
      return new Text(text, 0, 0);
    },
  });
}
