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

export type Verdict = {
  verdict: "allow" | "deny" | "ask";
  reason?: string;
  /**
   * The generic rule the judge says would cover this call. Inert: it grants
   * nothing in any scope, not even the session that produced it, so an
   * identical call is judged again; only an operator accepting it makes a rule.
   */
  proposedRule?: AllowRule;
};

/** Where an allow granted from the dialog is remembered. */
export type StoredScope = "worktree" | "global";

/** A durable scope, or the session the grant dies with. */
export type GrantScope = StoredScope | "conversation";

export type Block = { block: true; reason: string };

export interface PermissionHost {
  /** Whether a human can be asked; see `noHumanPresent`. */
  canAsk(): boolean;
  readRules(scope: StoredScope): AllowRule[];
  writeRules(scope: StoredScope, rules: AllowRule[]): void;
  /** The judge model's verdict on a call neither list settled. */
  judge(call: ToolCall, signal: AbortSignal): Promise<Verdict>;
  /** The dialog; the chosen label, or undefined when it was dismissed. */
  select(message: string, choices: string[]): Promise<string | undefined>;
  /**
   * The rule input, opened on the prefill; the operator's text, or undefined
   * when it was dismissed.
   */
  editRule(message: string, prefill: string): Promise<string | undefined>;
}

/** A judge that has not answered within this is treated as unavailable. */
export const JUDGE_TIMEOUT_MS = 30_000;

/**
 * A dialog nobody answers within this is a refusal. Only a backstop for a UI
 * that fails to reach anyone: deciding on a permission legitimately takes
 * minutes, so this must be far longer than any human deliberation, which is
 * exactly why it cannot be the signal that nobody is there.
 */
export const SELECT_TIMEOUT_MS = 30 * 60_000;

/**
 * A dialog's answer, or `answered: false` once the wait is over. A dialog that
 * fails reads as dismissed, not as unanswered: someone was there.
 */
export async function answerWithin<T>(
  answer: Promise<T>,
  ms: number,
): Promise<{ answered: boolean; value?: T }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      answer.then(
        (value) => ({ answered: true, value }),
        () => ({ answered: true }),
      ),
      new Promise<{ answered: boolean }>((resolve) => {
        timer = setTimeout(() => resolve({ answered: false }), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Set by the subagent launcher on its child; a loop carries CODASS_LOOP. */
export const NO_HUMAN_ENV = "CODASS_NO_HUMAN";

/**
 * Whether this session has nobody to ask: a subagent child, a codass loop, or
 * a print/json run. How the session was launched is the signal, never whether
 * pi reports a UI — an RPC subagent reports one that reaches no one.
 */
export function noHumanPresent(
  env: Record<string, string | undefined>,
  argv: readonly string[],
): boolean {
  if (env[NO_HUMAN_ENV] === "1" || env.CODASS_LOOP) return true;
  const flags = argv.slice(2);
  const end = flags.indexOf("--");
  const args = end === -1 ? flags : flags.slice(0, end);
  return args.some(
    (arg, index) =>
      arg === "--print" ||
      arg === "-p" ||
      (arg === "--mode" && args[index + 1] === "json"),
  );
}

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

const GRANT_SCOPES = new Map<string, GrantScope>([
  ["Allow for this conversation", "conversation"],
  ["Allow for this worktree", "worktree"],
  ["Allow globally", "global"],
]);

export const JUDGE_SYSTEM_PROMPT = `You decide whether a coding agent may run a tool call.

Answer with one JSON object and nothing else:
{"verdict": "allow" | "deny" | "ask", "reason": "<one short sentence>",
 "proposedRule": "<optional allow rule>"}

allow: routine, reversible work.
deny: destructive, irreversible work — data loss, credentials, publishing, or
  reaching machines the task never mentioned.
ask: independent command risks a careful engineer would want to see before it runs.
A string argument ending in … was cut for display; judge from what is shown.
Filesystem locations, different project roots, and folders outside the working
 directory are authorized by the filesystem sandbox, never by this verdict.
When unsure, answer ask.

You are also given what the human asked for: the user-authored messages of the
conversation, newest first, and the active goal when one is set. The agent's own
prose is never shown, so a call cannot justify itself. Work the call has been
asked for is routine even when its command is unfamiliar. A compaction summary
appears only when no user message survives; it is the agent's own account, so it
is weaker evidence.

proposedRule is optional and names the shape of call a human could reasonably
approve once for all, as \`tool(pattern)\` — \`bash(just uv run python:*)\` rather
than the command verbatim, a trailing \`:*\` reading as "this prefix, then
anything". It grants nothing on its own: a human reviews and tightens it before
it is ever in force, whatever the verdict. Omit it when no generic shape of this
call would be safe to approve.`;

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

/**
 * What an `mcp` call reaches. The adapter routes every server through this one
 * tool, so its arguments — a different url or element ref every time — identify
 * nothing; the tool being called, or the gateway mode, is what a rule can name.
 * The order mirrors the adapter's own dispatch.
 */
function mcpTargetOf(input: unknown): string {
  const params = (input ?? {}) as Record<string, unknown>;
  const text = (key: string): string | undefined =>
    typeof params[key] === "string" ? (params[key] as string) : undefined;
  const action = text("action");
  if (action === "auth-start") return "auth/start";
  if (action === "auth-complete") return "auth/complete";
  if (action) return `gateway/${action}`;
  const tool = text("tool");
  // A tool named without its server keeps the name the model wrote; the two
  // spellings are separate subjects, and a server-wide rule covers both.
  if (tool) {
    const server = text("server");
    return server ? `${server}/${tool}` : tool;
  }
  if (text("connect")) return "gateway/connect";
  if (text("describe")) return "gateway/describe";
  if (text("instructions")) return "gateway/instructions";
  if (params.search !== undefined) return "gateway/search";
  if (text("server")) return "gateway/list";
  return "gateway/status";
}

/** The text a rule is matched against: the command, the path, or the arguments. */
export function subjectOf(call: ToolCall): string {
  if (call.toolName === "bash") return call.command ?? "";
  if (typeof call.path === "string") return call.path;
  if (call.toolName === "subagent") return subagentsOf(call.input) ?? "";
  if (call.toolName === "mcp") return mcpTargetOf(call.input);
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

/** What the human asked for, as far as the judge is told it. */
export type JudgeContext = {
  /** User-authored messages of the current branch, newest first. */
  userMessages?: string[];
  /** Stands in only when a compaction left the branch without a user message. */
  compactionSummary?: string;
  /** The condition of the active goal, when one is set. */
  goal?: string;
};

/** Beyond this, the human's messages are dropped, oldest first. */
export const REQUEST_LIMIT = 4000;

/** What `### message N (newest)` and its blank lines add to a kept record. */
const HEADING_COST = 26;

/**
 * The messages that fit, newest first. A record is kept whole or not at all, so
 * no text is ever read as part of a neighbouring message; the newest alone over
 * the cap is the one exception, cut and marked rather than dropped.
 */
function withinRequestLimit(messages: string[], limit: number): string[] {
  const kept: string[] = [];
  let used = 0;
  for (const message of messages) {
    const text = message.trim();
    if (!text) continue;
    // The heading each record is rendered under counts too, or a long run of
    // one-word turns blows the cap in headings alone.
    const cost = text.length + HEADING_COST;
    if (used + cost > limit) {
      if (kept.length === 0) kept.push(`${text.slice(0, limit)}… (cut)`);
      break;
    }
    kept.push(text);
    used += cost;
  }
  return kept;
}

/**
 * The call as the model wrote it, and what the human asked for: the branch's
 * user-authored messages newest first — the substantive request often sits
 * several turns behind a bare "continue" — and the active goal. Assistant text
 * is excluded, so the call being judged cannot supply its own justification.
 */
export function judgeInput(
  call: ToolCall,
  cwd: string,
  context: JudgeContext = {},
): string {
  const subject =
    call.toolName === "bash"
      ? `command: ${call.command}`
      : typeof call.path === "string"
        ? `path: ${call.path}`
        : `arguments: ${digestOf(call)}`;
  const sections = [
    `working directory: ${cwd}\ntool: ${call.toolName}\n${subject}`,
  ];
  if (context.goal) sections.push(`active goal: ${context.goal}`);
  const messages = withinRequestLimit(
    context.userMessages ?? [],
    REQUEST_LIMIT,
  );
  if (messages.length) {
    sections.push(
      [
        "## What the human asked for, newest first",
        ...messages.map(
          (text, index) =>
            `### message ${index + 1}${index === 0 ? " (newest)" : ""}\n${text}`,
        ),
      ].join("\n\n"),
    );
  } else if (context.compactionSummary?.trim()) {
    sections.push(
      [
        "## What the human asked for, newest first",
        "No user message survives in this branch; the compaction summary stands in, as weaker evidence.",
        `### compaction summary\n${context.compactionSummary.trim().slice(0, REQUEST_LIMIT)}`,
      ].join("\n\n"),
    );
  }
  return sections.join("\n\n");
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

/**
 * A rule in the `tool(pattern)` form, the only shape written to a rules file.
 * A bare tool name is refused here although the matcher honours it: it would
 * grant a whole tool from one call. So is a pattern of nothing but wildcards,
 * which grants the same thing one character later.
 */
const RULE_SHAPE = /^[A-Za-z0-9_.*-]+\(([^\n]+)\)$/;

export function isAllowRule(rule: string): boolean {
  const pattern = RULE_SHAPE.exec(rule.trim())?.[1];
  return pattern !== undefined && /[^*:\s]/.test(pattern);
}

/** The rule the operator left in the input: its first line with text on it. */
function firstRule(text: string | undefined): AllowRule | undefined {
  return (text ?? "")
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean);
}

/**
 * The verbatim rule, when it could ever match again. A compound command is
 * dropped: `allowed()` matches each sub-command on its own, so a rule holding
 * the whole line — the `cd … && git commit -m "…"` entries the operator files
 * already carry — is dead the moment it is written.
 */
function matchableRuleFor(call: ToolCall): AllowRule | undefined {
  const rule = ruleFor(call);
  if (!rule || call.toolName !== "bash") return rule;
  return splitCommand(call.command ?? "")?.length === 1 ? rule : undefined;
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
  const { verdict, reason, proposedRule } = (parsed ?? {}) as Record<
    string,
    unknown
  >;
  const known = verdict === "allow" || verdict === "deny" || verdict === "ask";
  // Its destinations are a refusal the agent reads and an input whose result is
  // written as a rule, so a proposal that is not rule-shaped is no proposal.
  const rule =
    typeof proposedRule === "string" && isAllowRule(proposedRule)
      ? proposedRule.trim()
      : undefined;
  return {
    verdict: known ? verdict : "ask",
    reason: typeof reason === "string" ? reason : undefined,
    ...(rule ? { proposedRule: rule } : {}),
  };
}

/** The rule travels with a refusal so the reader can accept it and retry. */
function withProposedRule(reason: string, rule: AllowRule | undefined): string {
  return rule ? `${reason}\nproposed rule: ${rule}` : reason;
}

export class PermissionMachine {
  /** Allows granted for this conversation only; gone with the process. */
  private conversation: AllowRule[] = [];

  private config: PermissionConfig;
  private host: PermissionHost;
  private judgeTimeoutMs: number;
  private selectTimeoutMs: number;

  constructor(
    config: PermissionConfig,
    host: PermissionHost,
    options: { judgeTimeoutMs?: number; selectTimeoutMs?: number } = {},
  ) {
    this.config = config;
    this.host = host;
    this.judgeTimeoutMs = options.judgeTimeoutMs ?? JUDGE_TIMEOUT_MS;
    this.selectTimeoutMs = options.selectTimeoutMs ?? SELECT_TIMEOUT_MS;
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

    const { verdict, reason, proposedRule } = await this.judgeWithin(call);
    if (verdict === "allow") return undefined;
    if (verdict === "deny") {
      return {
        block: true,
        reason: withProposedRule(
          `permission denied: ${reason ?? "judged unsafe"}`,
          proposedRule,
        ),
      };
    }
    return this.ask(call, reason, proposedRule);
  }

  private async ask(
    call: ToolCall,
    reason: string | undefined,
    proposedRule?: AllowRule,
  ): Promise<Block | undefined> {
    const why = reason ?? "not covered by the permission rules";
    if (!this.host.canAsk()) {
      return {
        block: true,
        reason: withProposedRule(
          `permission refused (nobody to ask): ${why}`,
          proposedRule,
        ),
      };
    }
    const answer = await answerWithin(
      this.host.select(`${call.toolName}: ${digestOf(call)}\n${why}`, [
        ...CHOICES,
      ]),
      this.selectTimeoutMs,
    );
    if (!answer.answered) {
      return {
        block: true,
        reason: withProposedRule(
          `permission refused (dialog unanswered): ${why}`,
          proposedRule,
        ),
      };
    }
    const choice = answer.value;
    if (choice === "Allow once") return undefined;
    const scope = GRANT_SCOPES.get(choice ?? "");
    if (scope) return this.remember(call, scope, proposedRule);
    return {
      block: true,
      reason: withProposedRule(`permission refused: ${why}`, proposedRule),
    };
  }

  /**
   * The rule the operator authors, in the scope they named. They are handed the
   * judge's proposal to tighten, with the exact subject under it for a call
   * where nothing generic is safe; nothing reaches a file the operator has not
   * accepted. Storing nothing leaves the call allowed once, never a dead end.
   */
  private async remember(
    call: ToolCall,
    scope: GrantScope,
    proposedRule: AllowRule | undefined,
  ): Promise<undefined> {
    const verbatim = matchableRuleFor(call);
    const prefill = [...new Set([proposedRule, verbatim].filter(Boolean))].join(
      "\n",
    );
    // Nothing specific enough to remember: the grant degrades to allow once.
    if (!prefill) return undefined;
    const answer = await answerWithin(
      this.host.editRule(
        `rule to store (${scope}); the first line is kept, an empty input stores nothing`,
        prefill,
      ),
      this.selectTimeoutMs,
    );
    const rule = answer.answered ? firstRule(answer.value) : undefined;
    if (!rule || !isAllowRule(rule)) return undefined;
    if (scope === "conversation") {
      if (!this.conversation.includes(rule)) this.conversation.push(rule);
      return undefined;
    }
    const stored = this.host.readRules(scope);
    if (!stored.includes(rule)) {
      this.host.writeRules(scope, [...stored, rule]);
    }
    return undefined;
  }
}
