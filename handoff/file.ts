/**
 * `/handoff-file`: write the baton for the current branch and stop there.
 *
 * It shares the host and the generation input with `/handoff`, not the machine:
 * no captured input, no cancel, and no interaction with a handoff in progress.
 * Typed while the agent runs it waits for the turn to settle rather than
 * writing from a half-finished branch, and says so on a status line of its own.
 */

import { buildGenerationInput } from "./lib.ts";
import type { Host } from "./machine.ts";

/** What writing a baton needs of the handoff host, plus its own status line. */
export type FileHost = Pick<
  Host,
  | "isIdle"
  | "waitForIdle"
  | "conversation"
  | "systemPrompt"
  | "complete"
  | "handoffPath"
  | "writeFile"
  | "notify"
> & {
  /** A widget of the file writer's own: the machine keeps hold of its one. */
  setStatus(lines: string[] | undefined): void;
};

const SCHEDULED = "Handoff file: scheduled, writes when the agent settles";
const WRITING = "Handoff file: writing…";

/** One writer per session: the baton has a single path, so writes never overlap. */
export class HandoffFile {
  private running = false;

  async write(host: FileHost, focus: string): Promise<void> {
    if (this.running) {
      host.notify("Handoff file already in progress", "info");
      return;
    }
    this.running = true;
    try {
      await this.generate(host, focus);
    } catch (err) {
      host.notify(
        `Handoff file failed: ${(err as Error).message ?? err}`,
        "error",
      );
    } finally {
      this.running = false;
      host.setStatus(undefined);
    }
  }

  private async generate(host: FileHost, focus: string): Promise<void> {
    if (!host.isIdle()) {
      host.setStatus([SCHEDULED]);
      await host.waitForIdle();
    }
    const conversation = host.conversation();
    if (conversation === undefined) {
      host.notify("No conversation to hand off", "info");
      return;
    }
    host.setStatus([WRITING]);
    const handoff = await host.complete(
      host.systemPrompt(),
      buildGenerationInput(conversation, focus),
      // Nothing cancels a file write; the signal is the host's shape.
      new AbortController().signal,
    );
    if (handoff === null) {
      host.notify("Handoff file cancelled", "info");
      return;
    }
    const handoffPath = host.handoffPath();
    host.writeFile(handoffPath, `${handoff.trim()}\n`);
    host.notify(`Handoff file written (${handoffPath})`, "info");
  }
}
