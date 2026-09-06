/**
 * Pure helpers for the goal extension: its command, its session entry, the
 * judge's prompt and verdict, and the text it puts in the conversation.
 * Free of pi imports, as the handoff extension's `lib.ts` is.
 */

/** Custom session entry carrying the goal across resume and handoff. */
export const GOAL_ENTRY_TYPE = "goal";

/** Tool-less turns in a row after which the goal stops driving itself. */
export const STALL_TURNS = 3;

export interface GoalEntry {
  /** The condition, or null once the goal is cleared. */
  condition: string | null;
  /** Seeded into a successor conversation: re-arming there resumes the work. */
  viaHandoff?: boolean;
}

function isEntry(data: unknown): data is GoalEntry {
  if (typeof data !== "object" || data === null) return false;
  const { condition } = data as Record<string, unknown>;
  return typeof condition === "string" || condition === null;
}

/** The last goal recorded in a session's entries, or undefined when none is active. */
export function goalFromEntries(
  entries: readonly { type: string }[],
): GoalEntry | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i] as {
      type: string;
      customType?: string;
      data?: unknown;
    };
    if (entry.type !== "custom" || entry.customType !== GOAL_ENTRY_TYPE)
      continue;
    if (!isEntry(entry.data) || entry.data.condition === null) return undefined;
    return entry.data;
  }
  return undefined;
}

export type GoalCommand =
  | { kind: "status" }
  | { kind: "clear" }
  | { kind: "set"; condition: string };

export function parseGoalCommand(args: string): GoalCommand {
  const text = args.trim();
  if (text === "") return { kind: "status" };
  if (text === "clear") return { kind: "clear" };
  return { kind: "set", condition: text };
}

export type VerdictKind = "met" | "not-yet" | "impossible";

export interface Verdict {
  kind: VerdictKind;
  reason: string;
}

export const JUDGE_SYSTEM_PROMPT = `You judge whether a coding agent has reached a goal.

You are given the goal condition and the conversation so far. Decide only from what the conversation shows; never assume work that is not evidenced there.

Answer in exactly two lines:

VERDICT: met | not-yet | impossible
REASON: one or two sentences.

- met: the condition is satisfied.
- not-yet: work remains. The reason is sent to the agent as its next instruction, so write it as the next step to take, addressed to the agent.
- impossible: the condition cannot be reached as stated, for a reason the agent cannot work around.`;

export function judgeInput(condition: string, conversation: string): string {
  return `## Goal condition\n\n${condition}\n\n## Conversation\n\n${conversation}`;
}

const VERDICT_LINE = /verdict\s*:\s*(met|not[-\s]?yet|impossible)/i;
const REASON_LINE = /reason\s*:\s*([\s\S]+)/i;

/** The judge's answer, or undefined when it is not one — the goal stays armed then. */
export function parseVerdict(text: string): Verdict | undefined {
  const verdict = VERDICT_LINE.exec(text);
  if (!verdict) return undefined;
  const word = verdict[1].toLowerCase().replace(/[\s_]/g, "-");
  const kind: VerdictKind =
    word === "met" || word === "impossible" ? word : "not-yet";
  const reason = REASON_LINE.exec(text);
  return { kind, reason: reason ? reason[1].trim() : "" };
}

/** The turn a freshly set goal starts with. */
export function directive(condition: string): string {
  return `Work towards this goal until it is reached: ${condition}`;
}

/** The turn a goal re-armed in a successor conversation continues with. */
export function resumeDirective(condition: string): string {
  return `Continue working towards the goal carried over from the previous conversation: ${condition}`;
}

/** The turn a `not yet` verdict starts: the judge's reason is the instruction. */
export function continueMessage(reason: string): string {
  return reason || "The goal is not reached yet; keep working towards it.";
}

/** What is written into the conversation when the goal settles. */
export function verdictRecord(condition: string, verdict: Verdict): string {
  const headline = verdict.kind === "met" ? "Goal met" : "Goal impossible";
  return [`${headline}: ${condition}`, verdict.reason]
    .filter(Boolean)
    .join("\n\n");
}

export function stallWarning(condition: string): string {
  return `Goal stopped after ${STALL_TURNS} turns without a tool call; it stays set on "${condition}" and resumes on your next message.`;
}

function elapsed(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}`;
}

export interface GoalStatus {
  condition: string;
  elapsedSeconds: number;
  evaluated: number;
  lastReason?: string;
  stalled: boolean;
}

export function statusText(status: GoalStatus | undefined): string {
  if (!status) return "No goal set. /goal <condition> sets one.";
  const parts = [
    `Goal: ${status.condition}`,
    `${elapsed(status.elapsedSeconds)} elapsed, ${status.evaluated} turn(s) evaluated${status.stalled ? ", stopped on a stall" : ""}`,
  ];
  if (status.lastReason) parts.push(`Last verdict: ${status.lastReason}`);
  return parts.join("\n");
}

/** The footer marker while a goal is active. */
export function goalIndicator(condition: string, width = 32): string {
  const text =
    condition.length > width ? `${condition.slice(0, width - 1)}…` : condition;
  return `goal: ${text}`;
}

/** The focus note the baton is written under while a goal is active. */
export function goalFocus(condition: string): string {
  return [
    `A goal is active in this conversation: "${condition}".`,
    "Write the baton so the next conversation can carry that goal to its end:",
    "what has been done towards it, what is left, and what must not be redone.",
  ].join(" ");
}
