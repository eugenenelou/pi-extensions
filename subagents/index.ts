/**
 * Subagent tool - delegate tasks to specialized agents.
 *
 * Spawns a separate `pi -p -a` process per invocation, giving each subagent an
 * isolated context window. Modes: single, parallel, chain (`{previous}`).
 *
 * Children are spawned with `-a`, so they trust and load the same project
 * `.pi/settings.json` and therefore this extension: subagents can spawn
 * subagents.
 *
 * An agent that declares `mcpServers` gets them in-memory only: the parent
 * writes the resolved config to a 0600 temp file and points the child at it via
 * PI_SUBAGENT_MCP_CONFIG, which the child hands to the pi-mcp-adapter instance
 * loaded from settings `packages`. Nothing is written to `.mcp.json`, and the
 * parent session never loads those servers.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type {
  AgentToolResult,
  ThinkingLevel,
} from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import {
  type ExtensionAPI,
  getMarkdownTheme,
  withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { registerMcpServer } from "pi-mcp-adapter";
import type { ServerEntry } from "pi-mcp-adapter/types";
import { Type } from "typebox";
import { type AgentConfig, discoverAgents } from "./agents.ts";

const MAX_PARALLEL_TASKS = 8;
const MAX_CONCURRENCY = 4;
const COLLAPSED_ITEM_COUNT = 10;
const PER_TASK_OUTPUT_CAP = 50 * 1024;
const MCP_CONFIG_ENV = "PI_SUBAGENT_MCP_CONFIG";

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

interface UsageStats {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  contextTokens: number;
  turns: number;
}

interface SingleResult {
  agent: string;
  agentSource: "user" | "project" | "unknown";
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

interface SubagentDetails {
  mode: "single" | "parallel" | "chain";
  projectAgentsDir: string | null;
  results: SingleResult[];
}

function getFinalOutput(messages: Message[]): string {
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

function isFailedResult(result: SingleResult): boolean {
  return (
    result.exitCode !== 0 ||
    result.stopReason === "error" ||
    result.stopReason === "aborted"
  );
}

function getResultOutput(result: SingleResult): string {
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

function truncateOutput(output: string): string {
  const byteLength = Buffer.byteLength(output, "utf8");
  if (byteLength <= PER_TASK_OUTPUT_CAP) return output;

  let truncated = output.slice(0, PER_TASK_OUTPUT_CAP);
  while (Buffer.byteLength(truncated, "utf8") > PER_TASK_OUTPUT_CAP)
    truncated = truncated.slice(0, -1);
  return `${truncated}\n\n[Output truncated: ${byteLength - Buffer.byteLength(truncated, "utf8")} bytes omitted. Full output preserved in tool details.]`;
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

async function writeTempFile(
  prefix: string,
  name: string,
  content: string,
): Promise<{ dir: string; filePath: string }> {
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), prefix));
  const filePath = path.join(tmpDir, name.replace(/[^\w.-]+/g, "_"));
  await withFileMutationQueue(filePath, async () => {
    await fs.promises.writeFile(filePath, content, {
      encoding: "utf-8",
      mode: 0o600,
    });
  });
  return { dir: tmpDir, filePath };
}

function removeTemp(dir: string | null, filePath: string | null): void {
  if (filePath) {
    try {
      fs.unlinkSync(filePath);
    } catch {
      /* ignore */
    }
  }
  if (dir) {
    try {
      fs.rmdirSync(dir);
    } catch {
      /* ignore */
    }
  }
}

function findPiOnDisk(): string | null {
  const candidates = [
    ...(process.env.PATH ?? "")
      .split(path.delimiter)
      .filter(Boolean)
      .map((dir) => path.join(dir, "pi")),
    path.join(os.homedir(), ".local", "share", "pnpm", "pi"),
  ];
  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      /* keep looking */
    }
  }
  return null;
}

/**
 * Re-run the current pi entry script under the same runtime when possible; the
 * `pi` shim is not always on the child's PATH.
 */
function getPiInvocation(args: string[]): { command: string; args: string[] } {
  const currentScript = process.argv[1];
  const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
  if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
    return { command: process.execPath, args: [currentScript, ...args] };
  }

  const execName = path.basename(process.execPath).toLowerCase();
  if (!/^(node|bun)(\.exe)?$/.test(execName))
    return { command: process.execPath, args };

  return { command: findPiOnDisk() ?? "pi", args };
}

type OnUpdateCallback = (partial: AgentToolResult<SubagentDetails>) => void;

interface DispatchDefaults {
  model?: string;
  thinkingLevel?: ThinkingLevel;
}

async function runSingleAgent(
  defaultCwd: string,
  dispatchDefaults: DispatchDefaults,
  agents: AgentConfig[],
  agentName: string,
  task: string,
  cwd: string | undefined,
  step: number | undefined,
  signal: AbortSignal | undefined,
  onUpdate: OnUpdateCallback | undefined,
  makeDetails: (results: SingleResult[]) => SubagentDetails,
): Promise<SingleResult> {
  const agent = agents.find((a) => a.name === agentName);

  if (!agent) {
    const available = agents.map((a) => `"${a.name}"`).join(", ") || "none";
    return {
      agent: agentName,
      agentSource: "unknown",
      task,
      exitCode: 1,
      messages: [],
      stderr: `Unknown agent: "${agentName}". Available agents: ${available}.`,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0,
        contextTokens: 0,
        turns: 0,
      },
      step,
    };
  }

  const args: string[] = ["--mode", "json", "-p", "--no-session", "-a"];
  const model = agent.model ?? dispatchDefaults.model;
  if (model) args.push("--model", model);
  const thinking =
    agent.thinking ??
    (agent.model ? undefined : dispatchDefaults.thinkingLevel);
  if (thinking) args.push("--thinking", thinking);
  if (agent.tools && agent.tools.length > 0)
    args.push("--tools", agent.tools.join(","));

  let tmpPrompt: { dir: string; filePath: string } | null = null;
  let tmpMcp: { dir: string; filePath: string } | null = null;

  const currentResult: SingleResult = {
    agent: agentName,
    agentSource: agent.source,
    task,
    exitCode: 0,
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
      tmpPrompt = await writeTempFile(
        "pi-subagent-",
        `prompt-${agent.name}.md`,
        agent.systemPrompt,
      );
      args.push("--append-system-prompt", tmpPrompt.filePath);
    }

    const childEnv: NodeJS.ProcessEnv = { ...process.env };
    if (agent.mcpServers) {
      tmpMcp = await writeTempFile(
        "pi-subagent-mcp-",
        `mcp-${agent.name}.json`,
        JSON.stringify({ mcpServers: agent.mcpServers }, null, 2),
      );
      childEnv[MCP_CONFIG_ENV] = tmpMcp.filePath;
    } else {
      // A nested child must not inherit its parent's inline servers.
      delete childEnv[MCP_CONFIG_ENV];
    }

    args.push(`Task: ${task}`);
    let wasAborted = false;

    const exitCode = await new Promise<number>((resolve) => {
      const invocation = getPiInvocation(args);
      const proc = spawn(invocation.command, invocation.args, {
        cwd: cwd ?? defaultCwd,
        env: childEnv,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let buffer = "";

      const processLine = (line: string) => {
        if (!line.trim()) return;
        let event: any;
        try {
          event = JSON.parse(line);
        } catch {
          return;
        }

        if (event.type === "message_end" && event.message) {
          const msg = event.message as Message;
          currentResult.messages.push(msg);

          if (msg.role === "assistant") {
            currentResult.usage.turns++;
            const usage = msg.usage;
            if (usage) {
              currentResult.usage.input += usage.input || 0;
              currentResult.usage.output += usage.output || 0;
              currentResult.usage.cacheRead += usage.cacheRead || 0;
              currentResult.usage.cacheWrite += usage.cacheWrite || 0;
              currentResult.usage.cost += usage.cost?.total || 0;
              currentResult.usage.contextTokens = usage.totalTokens || 0;
            }
            if (!currentResult.model && msg.model)
              currentResult.model = msg.model;
            if (msg.stopReason) currentResult.stopReason = msg.stopReason;
            if (msg.errorMessage) currentResult.errorMessage = msg.errorMessage;
          }
          emitUpdate();
        }

        if (event.type === "tool_result_end" && event.message) {
          currentResult.messages.push(event.message as Message);
          emitUpdate();
        }
      };

      proc.stdout.on("data", (data) => {
        buffer += data.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) processLine(line);
      });

      proc.stderr.on("data", (data) => {
        currentResult.stderr += data.toString();
      });

      proc.on("close", (code) => {
        if (buffer.trim()) processLine(buffer);
        resolve(code ?? 0);
      });

      proc.on("error", () => resolve(1));

      if (signal) {
        const killProc = () => {
          wasAborted = true;
          proc.kill("SIGTERM");
          setTimeout(() => {
            if (!proc.killed) proc.kill("SIGKILL");
          }, 5000);
        };
        if (signal.aborted) killProc();
        else signal.addEventListener("abort", killProc, { once: true });
      }
    });

    currentResult.exitCode = exitCode;
    if (wasAborted) throw new Error("Subagent was aborted");
    return currentResult;
  } finally {
    removeTemp(tmpPrompt?.dir ?? null, tmpPrompt?.filePath ?? null);
    removeTemp(tmpMcp?.dir ?? null, tmpMcp?.filePath ?? null);
  }
}

const TaskItem = Type.Object({
  agent: Type.String({ description: "Name of the agent to invoke" }),
  task: Type.String({ description: "Task to delegate to the agent" }),
  cwd: Type.Optional(
    Type.String({ description: "Working directory for the agent process" }),
  ),
});

const ChainItem = Type.Object({
  agent: Type.String({ description: "Name of the agent to invoke" }),
  task: Type.String({
    description: "Task with optional {previous} placeholder for prior output",
  }),
  cwd: Type.Optional(
    Type.String({ description: "Working directory for the agent process" }),
  ),
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
});

/**
 * Hand this child's inline servers to the pi-mcp-adapter already installed from
 * settings `packages`. A second adapter instance (`createMcpAdapter`) cannot be
 * used here: it would re-register `mcp`, `mcpScript` and `--mcp-config`, which
 * pi rejects as conflicts and which aborts the session. Registrations are
 * runtime-scoped and never persisted.
 */
function registerInlineMcpServers(pi: ExtensionAPI): void {
  const configPath = process.env[MCP_CONFIG_ENV];
  if (!configPath) return;

  let servers: Record<string, unknown>;
  try {
    servers = JSON.parse(fs.readFileSync(configPath, "utf-8")).mcpServers ?? {};
  } catch (err) {
    console.error(
      `subagents: could not read ${MCP_CONFIG_ENV} at ${configPath}: ${err}`,
    );
    return;
  }

  pi.on("session_start", () => {
    for (const [name, definition] of Object.entries(servers)) {
      try {
        registerMcpServer({ pi, name, definition: definition as ServerEntry });
      } catch (err) {
        console.error(
          `subagents: could not register MCP server "${name}": ${err}`,
        );
      }
    }
  });
}

export default function (pi: ExtensionAPI) {
  registerInlineMcpServers(pi);

  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description: [
      "Delegate tasks to specialized subagents, each with its own isolated context and model.",
      "Modes: single (agent + task), parallel (tasks array), chain (sequential with {previous} placeholder).",
      "Agents are defined in .pi/agents/*.md (project) and ~/.pi/agent/agents/*.md (user).",
    ].join(" "),
    parameters: SubagentParams,

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const dispatchDefaults: DispatchDefaults = {
        model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
        thinkingLevel: ctx.thinkingLevel,
      };
      const discovery = discoverAgents(ctx.cwd);
      const agents = discovery.agents;

      const hasChain = (params.chain?.length ?? 0) > 0;
      const hasTasks = (params.tasks?.length ?? 0) > 0;
      const hasSingle = Boolean(params.agent && params.task);
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

          const result = await runSingleAgent(
            ctx.cwd,
            dispatchDefaults,
            agents,
            step.agent,
            taskWithContext,
            step.cwd,
            i + 1,
            signal,
            chainUpdate,
            makeDetails("chain"),
          );
          results.push(result);

          if (isFailedResult(result)) {
            return {
              content: [
                {
                  type: "text",
                  text: `Chain stopped at step ${i + 1} (${step.agent}): ${truncateOutput(getResultOutput(result))}`,
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
              signal,
              (partial) => {
                if (partial.details?.results[0]) {
                  allResults[index] = partial.details.results[0];
                  emitParallelUpdate();
                }
              },
              makeDetails("parallel"),
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
        params.agent as string,
        params.task as string,
        params.cwd,
        undefined,
        signal,
        onUpdate,
        makeDetails("single"),
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
        `${theme.fg("toolTitle", theme.bold("subagent ")) + theme.fg("accent", args.agent || "...")}\n  ${theme.fg("dim", preview)}`,
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
