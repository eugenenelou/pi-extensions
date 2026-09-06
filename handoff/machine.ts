/**
 * The /handoff state machine, free of pi imports so it runs under node:test
 * against a fake host. `index.ts` builds the host from pi's extension context.
 */

import {
  buildAttachment,
  buildGenerationInput,
  restoreEditorText,
  widgetLines,
} from "./lib.ts";

export type Phase = "idle" | "armed" | "writing" | "switching";

/** What the new session must accept from the machine. */
export interface NextSession {
  /** Append a displayed custom message now, before anything else runs. */
  appendMessage(text: string): void;
  /** The old session's context is stale after the switch; the widget is cleared here. */
  clearWidget(): void;
  /** Send a user message; resolves once its turn has settled. */
  sendUserMessage(text: string): Promise<void>;
  notify(message: string, level: "info" | "warning" | "error"): void;
}

/** What the machine needs from the current session. */
export interface Host {
  isIdle(): boolean;
  waitForIdle(): Promise<void>;
  notify(message: string, level: "info" | "warning" | "error"): void;
  setWidget(lines: string[] | undefined): void;
  getEditorText(): string;
  setEditorText(text: string): void;
  /** Serialized current branch, or undefined when there is nothing to hand off. */
  conversation(): string | undefined;
  systemPrompt(): string;
  /** The model's handoff text, or null when aborted. */
  complete(
    systemPrompt: string,
    input: string,
    signal: AbortSignal,
  ): Promise<string | null>;
  handoffPath(): string;
  writeFile(path: string, text: string): void;
  newSession(
    withSession: (next: NextSession) => Promise<void>,
  ): Promise<{ cancelled: boolean }>;
}

/**
 * The same machine with no terminal: widget, editor stash and notifications go
 * nowhere, while idle detection, generation and the session switch stay live.
 */
export function headlessHost(host: Host, batonPath?: string): Host {
  return {
    ...host,
    notify: () => {},
    setWidget: () => {},
    getEditorText: () => "",
    setEditorText: () => {},
    handoffPath: () => batonPath ?? host.handoffPath(),
    newSession: (withSession) =>
      host.newSession((next) =>
        withSession({
          appendMessage: (text) => next.appendMessage(text),
          sendUserMessage: (text) => next.sendUserMessage(text),
          clearWidget: () => {},
          notify: () => {},
        }),
      ),
  };
}

const CANCELLED = "Handoff cancelled; queued inputs restored to the editor";

export class HandoffMachine {
  phase: Phase = "idle";
  stash: string[] = [];
  private abort: AbortController | undefined;
  /** The host of the run in progress; every effect of that run goes through it. */
  private host: Host | undefined;
  /** A run started off the bus is invisible, so it must not steal typed inputs. */
  private capturing = true;

  /** Extension `input` handler: true when the input was captured for the new session. */
  onInput(
    text: string,
    streamingBehavior: "steer" | "followUp" | undefined,
  ): boolean {
    if (!this.capturing) return false;
    const capture =
      this.phase === "writing" ||
      this.phase === "switching" ||
      (this.phase === "armed" && streamingBehavior === "followUp");
    if (!capture) return false;
    this.stash.push(text);
    if (this.host) this.host.setWidget(widgetLines(this.stash, this.phase));
    return true;
  }

  /** The switch to the new session fires this too, so the stash must survive it. */
  onSessionShutdown(): void {
    if (this.phase === "switching") return;
    this.phase = "idle";
    this.host = undefined;
    this.stash = [];
  }

  /** `/handoff` typed: starts a run, or cancels the one in progress. Returns at once. */
  command(host: Host, focus: string, goalActive = false): Promise<void> {
    if (this.phase !== "idle") {
      this.cancel(CANCELLED);
      return Promise.resolve();
    }
    return this.start(host, focus, goalActive, true);
  }

  /** Bus entry point: starts a run, and does nothing while one is in progress. */
  request(host: Host, focus: string, goalActive = false): Promise<void> {
    if (this.phase !== "idle") return Promise.resolve();
    return this.start(host, focus, goalActive, false);
  }

  private start(
    host: Host,
    focus: string,
    goalActive: boolean,
    capturing: boolean,
  ): Promise<void> {
    this.host = host;
    this.capturing = capturing;
    return this.run(host, focus, goalActive).catch((err) => {
      this.cancel(`Handoff failed: ${(err as Error).message ?? err}`);
    });
  }

  private setPhase(host: Host, next: Phase): void {
    this.phase = next;
    host.setWidget(next === "idle" ? undefined : widgetLines(this.stash, next));
  }


  /** Every effect lands on the run's own host, whoever asked for the cancel. */
  private cancel(why: string): void {
    const host = this.host;
    this.abort?.abort();
    this.abort = undefined;
    this.phase = "idle";
    this.host = undefined;
    if (host) {
      host.setWidget(undefined);
      if (this.stash.length > 0) {
        host.setEditorText(restoreEditorText(this.stash, host.getEditorText()));
      }
      host.notify(why, "info");
    }
    this.stash = [];
  }

  private async run(
    host: Host,
    focus: string,
    goalActive: boolean,
  ): Promise<void> {
    this.stash = [];
    if (!host.isIdle()) {
      this.setPhase(host, "armed");
      host.notify(
        "Handoff armed: runs when the agent settles; Alt+Enter inputs go to the new session",
        "info",
      );
      await host.waitForIdle();
      if (this.phase !== "armed") return;
    }
    this.setPhase(host, "writing");

    const conversation = host.conversation();
    if (conversation === undefined) {
      this.cancel("No conversation to hand off");
      return;
    }
    this.abort = new AbortController();
    let handoff: string | null;
    try {
      handoff = await host.complete(
        host.systemPrompt(),
        buildGenerationInput(conversation, focus, goalActive),
        this.abort.signal,
      );
    } catch (err) {
      this.cancel(`Handoff generation failed: ${(err as Error).message ?? err}`);
      return;
    }
    if (this.phase !== "writing") return;
    if (handoff === null) {
      this.cancel(CANCELLED);
      return;
    }
    this.abort = undefined;

    const handoffPath = host.handoffPath();
    host.writeFile(handoffPath, `${handoff.trim()}\n`);

    this.setPhase(host, "switching");
    const result = await host.newSession(async (next) => {
      next.appendMessage(buildAttachment(handoff));
      const toReplay = this.stash;
      this.stash = [];
      this.phase = "idle";
      this.host = undefined;
      next.clearWidget();
      if (toReplay.length === 0) {
        next.notify(
          `Handoff attached (${handoffPath}). Type the next task.`,
          "info",
        );
        return;
      }
      // Each send resolves when its turn settles, so the replay keeps the typed
      // order. Not awaited: it must outlive the session replacement.
      void (async () => {
        for (const text of toReplay) await next.sendUserMessage(text);
      })().catch((err) => {
        next.notify(
          `Handoff replay failed: ${(err as Error).message ?? err}`,
          "error",
        );
      });
    });
    if (result.cancelled) {
      this.cancel("New session cancelled; queued inputs restored to the editor");
    }
  }
}
