/**
 * The goal state machine, free of pi imports so it runs under node:test against
 * a fake host. `index.ts` builds the host from pi's extension context.
 *
 * One goal at a time: it is set from the command or re-armed from the session,
 * judged once per agent run, and it drives the next run itself until the judge
 * says met or impossible. A stretch of tool-less runs stops that driving without
 * dropping the goal, so a user message can restart it.
 */

import {
  continueMessage,
  directive,
  type GoalEntry,
  type GoalStatus,
  goalFocus,
  goalIndicator,
  STALL_TURNS,
  stallWarning,
  type Verdict,
  verdictRecord,
} from "./lib.ts";

/** What the machine needs from the session. */
export interface GoalHost {
  /** Epoch seconds. */
  now(): number;
  /** Persist the goal as a custom session entry. */
  append(entry: GoalEntry): void;
  /** Send a user message that starts a turn. */
  send(text: string): void;
  /** Put text in the conversation without starting a turn. */
  record(text: string): void;
  notify(message: string, level: "info" | "warning" | "error"): void;
  /** The conversation so far, or undefined when there is nothing to judge. */
  conversation(): string | undefined;
  /**
   * Resolve once the session is idle; false when it did not become idle in time.
   *
   * A run is still active when it ends, and a message sent into one is refused.
   */
  waitForIdle(): Promise<boolean>;
  /** The small model's verdict, or undefined when it did not answer one. */
  judge(condition: string, conversation: string): Promise<Verdict | undefined>;
  /** Hold automatic handoff on, with the goal as focus and as the seed entry. */
  hold(focus: string, seed: GoalEntry): void;
  release(): void;
}

interface Active {
  condition: string;
  startedAt: number;
  evaluated: number;
  lastReason?: string;
}

export class GoalMachine {
  private goal: Active | undefined;
  private toolless = 0;
  private stalled = false;
  /** Whether the run in progress has called a tool, in any of its turns. */
  private usedTool = false;
  /** One evaluation at a time; a run ending during one is judged by the next. */
  private judging = false;

  private readonly host: GoalHost;

  constructor(host: GoalHost) {
    this.host = host;
  }

  active(): boolean {
    return this.goal !== undefined;
  }

  indicator(): string | undefined {
    return this.goal ? goalIndicator(this.goal.condition) : undefined;
  }

  status(): GoalStatus | undefined {
    if (!this.goal) return undefined;
    return {
      condition: this.goal.condition,
      elapsedSeconds: this.host.now() - this.goal.startedAt,
      evaluated: this.goal.evaluated,
      ...(this.goal.lastReason ? { lastReason: this.goal.lastReason } : {}),
      stalled: this.stalled,
    };
  }

  /** `/goal <condition>`: persist it, hold the handoff, and start working. */
  set(condition: string): void {
    this.arm(condition);
    this.host.append({ condition });
    this.host.send(directive(condition));
  }

  /**
   * Session start: re-arm the goal found in the session, with a fresh timer and
   * turn count. One seeded by a handoff is consumed — re-appended as a plain
   * entry — and the handoff itself sends the directive that resumes the work,
   * once the baton is the first entry of this conversation.
   */
  restore(entry: GoalEntry): void {
    if (entry.condition === null) return;
    this.arm(entry.condition);
    if (entry.viaHandoff) this.host.append({ condition: entry.condition });
  }

  /** `/goal clear`, and what a settled goal does. Returns the goal it dropped. */
  clear(): string | undefined {
    const condition = this.goal?.condition;
    if (!condition) return undefined;
    this.goal = undefined;
    this.toolless = 0;
    this.stalled = false;
    this.host.append({ condition: null });
    this.host.release();
    return condition;
  }

  /** A message the user actually typed: the stall guard starts over. */
  userPrompt(): void {
    this.toolless = 0;
    this.stalled = false;
  }

  /** Release the handoff hold without touching the goal: shutdown, or no goal here. */
  releaseHold(): void {
    this.host.release();
  }

  /** End of a turn: only note that the run in progress used a tool. */
  turnEnd(usedTool: boolean): void {
    if (usedTool) this.usedTool = true;
  }

  /** End of a run: judge the goal, then continue, settle, or stop on a stall. */
  async agentEnd(): Promise<void> {
    const goal = this.goal;
    const usedTool = this.usedTool;
    this.usedTool = false;
    if (!goal || this.stalled || this.judging) return;
    this.toolless = usedTool ? 0 : this.toolless + 1;
    const conversation = this.host.conversation();
    if (conversation === undefined) return;
    this.judging = true;
    let verdict: Verdict | undefined;
    try {
      verdict = await this.host.judge(goal.condition, conversation);
    } finally {
      this.judging = false;
    }
    // A judge that did not answer leaves the goal armed rather than ending it.
    if (!verdict || this.goal !== goal) return;
    goal.evaluated += 1;
    goal.lastReason = verdict.reason;
    if (verdict.kind !== "not-yet") {
      this.host.record(verdictRecord(goal.condition, verdict));
      this.clear();
      return;
    }
    if (this.toolless >= STALL_TURNS) {
      this.stalled = true;
      this.host.notify(stallWarning(goal.condition), "warning");
      return;
    }
    if (!(await this.host.waitForIdle())) return;
    // A run started while the judge was out drives the goal on by itself.
    if (this.goal !== goal || this.stalled) return;
    this.host.send(continueMessage(verdict.reason));
  }

  private arm(condition: string): void {
    this.goal = { condition, startedAt: this.host.now(), evaluated: 0 };
    this.toolless = 0;
    this.stalled = false;
    this.host.hold(goalFocus(condition), { condition, viaHandoff: true });
  }
}
