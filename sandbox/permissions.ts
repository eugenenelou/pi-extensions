/**
 * The permission decision for a tool call: the fixed deny list, then the fixed
 * allow list, then a side request to the judge model, whose "ask" opens the
 * five-choice dialog. Free of pi imports so it runs under node:test against a
 * fake host; `index.ts` builds the host from pi's extension context.
 *
 * Both fixed lists come from `permissions.json`, rendered by codass at deploy
 * from the guard list it also renders into the Claude permissions.
 */

/** A deny entry: a regular-expression source and the reason it exists. */
export type Guard = { reason: string; pattern: string };

/**
 * An allow entry in Claude's permission syntax: `Tool(pattern)` matches the
 * command of a bash call or the path of a file call, `*` being the only
 * wildcard and a trailing `:*` reading as Claude's prefix form; a bare token
 * matches the tool name, so `read` allows every read and `mcp__linear__*`
 * every tool of that server.
 */
export type AllowRule = string;

export type PermissionConfig = {
  deny?: Guard[];
  allow?: AllowRule[];
  /** Why the rule files could not be read; set means fail closed. */
  unreadable?: string;
};

export type ToolCall = {
  toolName: string;
  command?: string;
  path?: string;
  /** The raw tool arguments, for a tool that is neither bash nor a path tool. */
  input?: unknown;
};

export type Verdict = { verdict: "allow" | "deny" | "ask"; reason?: string };

/** Where an allow granted from the dialog is remembered. */
export type StoredScope = "worktree" | "global";

export type Block = { block: true; reason: string };

export interface PermissionHost {
  hasUI(): boolean;
  readRules(scope: StoredScope): AllowRule[];
  writeRules(scope: StoredScope, rules: AllowRule[]): void;
  /** The judge model's verdict on a call neither list settled. */
  judge(call: ToolCall, signal: AbortSignal): Promise<Verdict>;
  /** The dialog; the chosen label, or undefined when it was dismissed. */
  select(message: string, choices: string[]): Promise<string | undefined>;
}

/** A judge that has not answered within this is treated as unavailable. */
export const JUDGE_TIMEOUT_MS = 30_000;

/** Beyond this, arguments are too long to identify a call; nothing is remembered. */
const ARGUMENTS_LIMIT = 2000;

/** A string argument is shown to the judge and the dialog up to this length. */
const LEAF_LIMIT = 200;

export const CHOICES = [
  "Allow once",
  "Allow for this conversation",
  "Allow for this worktree",
  "Allow globally",
  "Refuse",
] as const;

export const JUDGE_SYSTEM_PROMPT = `You decide whether a coding agent may run a tool call.

Answer with one JSON object and nothing else:
{"verdict": "allow" | "deny" | "ask", "reason": "<one short sentence>"}

allow: routine, reversible work.
deny: destructive, irreversible work — data loss, credentials, publishing, or
  reaching machines the task never mentioned.
ask: independent command risks a careful engineer would want to see before it runs.
A string argument ending in … was cut for display; judge from what is shown.
Filesystem locations, different project roots, and folders outside the working
 directory are authorized by the filesystem sandbox, never by this verdict.
When unsure, answer ask.`;

/** Object keys sorted, so the same call renders to the same subject twice. */
function renderArguments(input: unknown): string {
  let text: string;
  try {
    text = JSON.stringify(input, (_key, value) =>
      value && typeof value === "object" && !Array.isArray(value)
        ? Object.fromEntries(
            Object.keys(value as object)
              .sort()
              .map((key) => [key, (value as Record<string, unknown>)[key]]),
          )
        : value,
    );
  } catch {
    return "";
  }
  return text && text.length <= ARGUMENTS_LIMIT ? text : "";
}

/** Every string leaf cut to LEAF_LIMIT, the structure kept. */
function abbreviate(value: unknown): unknown {
  if (typeof value === "string") {
    return value.length > LEAF_LIMIT ? `${value.slice(0, LEAF_LIMIT)}…` : value;
  }
  if (Array.isArray(value)) return value.map(abbreviate);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        abbreviate(item),
      ]),
    );
  }
  return value;
}

/**
 * The agents a subagent call delegates to. Its tasks are prose, so the rule
 * that identifies such a call is the set of agents, not the arguments.
 */
function subagentsOf(input: unknown): string | undefined {
  const args = (input ?? {}) as {
    agent?: unknown;
    tasks?: { agent?: unknown }[];
    chain?: { agent?: unknown }[];
  };
  const agents = [
    args.agent,
    ...(args.tasks ?? []).map((task) => task?.agent),
    ...(args.chain ?? []).map((step) => step?.agent),
  ].filter((agent): agent is string => typeof agent === "string");
  return agents.length ? [...new Set(agents)].sort().join(", ") : undefined;
}

/** The text a rule is matched against: the command, the path, or the arguments. */
export function subjectOf(call: ToolCall): string {
  if (call.toolName === "bash") return call.command ?? "";
  if (typeof call.path === "string") return call.path;
  if (call.toolName === "subagent") return subagentsOf(call.input) ?? "";
  return call.input === undefined ? "" : renderArguments(call.input);
}

/**
 * What the call does, for a reader: the command, the path, or the arguments
 * with long strings cut. Unlike the subject it never goes blank.
 */
export function digestOf(call: ToolCall): string {
  if (call.toolName === "bash") return call.command ?? "";
  if (typeof call.path === "string") return call.path;
  if (call.input === undefined) return "";
  try {
    return JSON.stringify(abbreviate(call.input), null, 2);
  } catch {
    return "(arguments not serializable)";
  }
}

/**
 * Where a shell would start another command. Command substitution and an
 * unbalanced quote hide one, so such a command does not split at all.
 */
export function splitCommand(command: string): string[] | undefined {
  if (/`|\$\(/.test(command)) return undefined;
  const parts: string[] = [];
  let current = "";
  let quote: string | undefined;
  for (let i = 0; i < command.length; i += 1) {
    const char = command[i];
    if (char === "\\" && quote !== "'") {
      current += char + (command[i + 1] ?? "");
      i += 1;
      continue;
    }
    if (quote) {
      if (char === quote) quote = undefined;
      current += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      current += char;
      continue;
    }
    if (char === ";" || char === "\n" || char === "&" || char === "|") {
      if ((char === "&" || char === "|") && command[i + 1] === char) i += 1;
      parts.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  if (quote) return undefined;
  parts.push(current);
  const commands = parts.map((part) => part.trim()).filter(Boolean);
  return commands.length ? commands : undefined;
}

function globToRegExp(pattern: string): RegExp {
  // Claude writes a prefix rule as `git status:*`: a whole word, then anything.
  const prefix = pattern.endsWith(":*");
  const glob = prefix ? pattern.slice(0, -2) : pattern;
  const source = glob
    .split("*")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("[^\\n]*");
  return new RegExp(`^${source}${prefix ? "(?:\\s[^\\n]*)?" : ""}$`);
}

function matchesSubject(
  rule: AllowRule,
  toolName: string,
  subject: string,
): boolean {
  const scoped = /^([^()]+)\(([\s\S]*)\)$/.exec(rule.trim());
  if (!scoped) {
    return globToRegExp(rule.trim().toLowerCase()).test(toolName.toLowerCase());
  }
  const [, tool, pattern] = scoped;
  if (tool.trim().toLowerCase() !== toolName.toLowerCase()) return false;
  return globToRegExp(pattern).test(subject);
}

export function matchesRule(rule: AllowRule, call: ToolCall): boolean {
  return matchesSubject(rule, call.toolName, subjectOf(call));
}

/**
 * The rule the dialog remembers: this tool, this exact subject. undefined when
 * the call carries no subject to pin the rule to, since a bare `tool()` rule
 * would grant the whole tool from one call.
 */
export function ruleFor(call: ToolCall): AllowRule | undefined {
  const subject = subjectOf(call);
  return subject ? `${call.toolName}(${subject})` : undefined;
}

/** A wrapper prefix must not hide what actually runs. */
function unwrapped(command: string): string {
  return command.replace(/^\s*rtk\s+/, "");
}

export function parseVerdict(text: string): Verdict {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start)
    return { verdict: "ask", reason: text.trim() };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return { verdict: "ask", reason: "judge answered unparseable JSON" };
  }
  const { verdict, reason } = (parsed ?? {}) as Record<string, unknown>;
  const known = verdict === "allow" || verdict === "deny" || verdict === "ask";
  return {
    verdict: known ? verdict : "ask",
    reason: typeof reason === "string" ? reason : undefined,
  };
}

export class PermissionMachine {
  /** Allows granted for this conversation only; gone with the process. */
  private conversation: AllowRule[] = [];

  private config: PermissionConfig;
  private host: PermissionHost;
  private judgeTimeoutMs: number;

  constructor(
    config: PermissionConfig,
    host: PermissionHost,
    options: { judgeTimeoutMs?: number } = {},
  ) {
    this.config = config;
    this.host = host;
    this.judgeTimeoutMs = options.judgeTimeoutMs ?? JUDGE_TIMEOUT_MS;
  }

  setConfig(config: PermissionConfig): void {
    this.config = config;
  }

  /** A new conversation starts with none of the previous one's allows. */
  reset(): void {
    this.conversation = [];
  }

  /** The reason the fixed deny list refuses this call, if it does. */
  denyReason(call: ToolCall): string | undefined {
    if (call.toolName !== "bash" || !call.command) return undefined;
    const probe = unwrapped(call.command);
    return (this.config.deny ?? []).find((guard) =>
      new RegExp(guard.pattern).test(probe),
    )?.reason;
  }

  allowed(call: ToolCall): boolean {
    const rules = [
      ...(this.config.allow ?? []),
      ...this.conversation,
      ...this.host.readRules("worktree"),
      ...this.host.readRules("global"),
    ];
    if (call.toolName !== "bash") {
      return rules.some((rule) => matchesRule(rule, call));
    }
    // Every sub-command of a compound command must be allowed on its own.
    const commands = splitCommand(call.command ?? "");
    return (
      commands !== undefined &&
      commands.every((command) =>
        rules.some((rule) => matchesSubject(rule, call.toolName, command)),
      )
    );
  }

  /** A judge that hangs must not hang the tool call. */
  private async judgeWithin(call: ToolCall): Promise<Verdict> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        this.host.judge(call, controller.signal),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new Error("judge timed out"));
          }, this.judgeTimeoutMs);
        }),
      ]);
    } catch (err) {
      return {
        verdict: "ask",
        reason: `judge unavailable (${err instanceof Error ? err.message : err})`,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  /** undefined lets the call through; a Block stops it with a reason. */
  async decide(call: ToolCall): Promise<Block | undefined> {
    const denied = this.denyReason(call);
    if (denied) return { block: true, reason: `permission denied: ${denied}` };
    const { unreadable } = this.config;
    if (unreadable) {
      return this.ask(call, `permission rules unreadable: ${unreadable}`);
    }
    if (this.allowed(call)) return undefined;

    const { verdict, reason } = await this.judgeWithin(call);
    if (verdict === "allow") return undefined;
    if (verdict === "deny") {
      return {
        block: true,
        reason: `permission denied: ${reason ?? "judged unsafe"}`,
      };
    }
    return this.ask(call, reason);
  }

  private async ask(
    call: ToolCall,
    reason: string | undefined,
  ): Promise<Block | undefined> {
    const why = reason ?? "not covered by the permission rules";
    if (!this.host.hasUI()) {
      return {
        block: true,
        reason: `permission refused (nobody to ask): ${why}`,
      };
    }
    const choice = await this.host.select(
      `${call.toolName}: ${digestOf(call)}\n${why}`,
      [...CHOICES],
    );
    if (choice === "Allow once") return undefined;
    if (
      choice === "Allow for this conversation" ||
      choice === "Allow for this worktree" ||
      choice === "Allow globally"
    ) {
      const rule = ruleFor(call);
      // Nothing specific enough to remember: the grant degrades to allow once.
      if (!rule) return undefined;
      if (choice === "Allow for this conversation") {
        this.conversation.push(rule);
        return undefined;
      }
      const scope: StoredScope =
        choice === "Allow globally" ? "global" : "worktree";
      const stored = this.host.readRules(scope);
      if (!stored.includes(rule)) {
        this.host.writeRules(scope, [...stored, rule]);
      }
      return undefined;
    }
    return { block: true, reason: `permission refused: ${why}` };
  }
}
