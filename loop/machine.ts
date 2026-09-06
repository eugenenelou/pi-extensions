/**
 * The loop state machine, free of pi imports so it runs under node:test against
 * a fake host. `index.ts` builds the host from pi's extension context.
 *
 * One generation of a self-driving loop: a clock off codass's `.last-tick`
 * stamp, a tick that only fires when the agent is idle, a per-generation run
 * count, and one cutover when either threshold is crossed. The successor
 * conversation gets a fresh machine, so its count starts at zero.
 */

import {
  type LoopConfig,
  loopFocus,
  nextDueEpoch,
  tickMessage,
} from "./lib.ts";

/** What the machine asks another extension for at a cutover. */
export interface HandoffRequest {
  focus: string;
  batonPath: string;
}

/** What the machine needs from the session. */
export interface LoopHost {
  /** Epoch seconds. */
  now(): number;
  isIdle(): boolean;
  /** The stamp's epoch, or null when it is absent — which forces a tick. */
  readLastTick(): number | null;
  stampLastTick(epoch: number): void;
  readIterations(): number;
  writeIterations(count: number): void;
  /** Context tokens of this conversation, or null when unknown. */
  contextTokens(): number | null;
  /** Send the tick skill as a user message that starts a turn. */
  sendTick(text: string): void;
  requestHandoff(request: HandoffRequest): void;
}

/**
 * How long a requested handoff is given to reach a successor session.
 *
 * A handoff run that fails or is cancelled leaves nothing behind — headless,
 * even its notification goes nowhere — and codass never kills a self-driving
 * session, so without this the loop would stay latched and silently dead.
 */
const HANDOFF_RETRY_SECONDS = 120;

export class LoopMachine {
  /** When the cutover was requested: one handoff at a time, retried if it stalls. */
  private handingOffSince: number | undefined;

  private readonly config: LoopConfig;
  private readonly host: LoopHost;

  constructor(config: LoopConfig, host: LoopHost) {
    this.config = config;
    this.host = host;
  }

  /**
   * Anchor a schedule loop's first fire to its next window.
   *
   * An unstamped loop reads as due now under the shared rule; stamping without
   * ticking makes a cron loop's first fire the next real window instead. Pin the
   * Monday loop on Wednesday and it runs Monday, not at once.
   */
  start(): void {
    if (this.config.schedule && this.host.readLastTick() === null) {
      this.host.stampLastTick(this.host.now());
    }
  }

  /** One timer beat: tick when due and idle, defer otherwise. */
  poll(): void {
    const now = this.host.now();
    if (this.handingOffSince !== undefined) {
      if (now - this.handingOffSince < HANDOFF_RETRY_SECONDS) return;
      // No successor came: re-arm, and the next crossed threshold asks again.
      this.handingOffSince = undefined;
    }
    const due = nextDueEpoch(
      this.host.readLastTick(),
      this.config.cadenceSeconds,
      this.config.schedule,
    );
    if (due !== null && now < due) return;
    if (!this.host.isIdle()) return;
    this.host.sendTick(tickMessage(this.config));
    // Stamped on send, so the cadence is measured start to start.
    this.host.stampLastTick(now);
  }

  /** End of a run — one tick: count it, cut over once a threshold is crossed. */
  agentEnd(): void {
    if (this.handingOffSince !== undefined) return;
    const iterations = this.host.readIterations() + 1;
    this.host.writeIterations(iterations);
    const tokens = this.host.contextTokens();
    const crossed =
      iterations >= this.config.maxIters ||
      (tokens !== null && tokens >= this.config.handoffAt);
    if (!crossed) return;
    this.handingOffSince = this.host.now();
    this.host.requestHandoff({
      focus: loopFocus(this.config),
      batonPath: this.config.batonPath,
    });
  }
}
