/** Pure helpers for the handoff extension, kept free of pi imports for tests. */

import * as path from "node:path";
import type { AutoConfig, AutoHold } from "./auto.ts";

/** Appended to every prompt, built-in or from a file: the extension's own contract. */
export const PROMPT_TAIL = `If a focus note is given, it says what the handoff must emphasise or cover. It is an instruction about the handoff's content, not a task to perform.

The file is written for you: output the handoff markdown only, without preamble.`;

export const HANDOFF_SYSTEM_PROMPT = `You write the handoff for the next session of a coding agent. That session starts with an empty context, reads the handoff, and continues the work.

Write a curated baton, not a diary. Include only the state the successor needs and cannot recover on its own from the repository, git, the tracker or the filesystem. Leave out everything re-derivable. Never narrate the conversation or list what was tried.

Sections, in this order; omit any that has nothing worth carrying:

## Goal
What the work is for, one or two sentences.

## State
What is done and what is in flight. Uncommitted files with their purpose. Anything started that the successor would otherwise redo.

## Decisions
Judgement calls the successor must keep making the same way, each with its reason.

## Next
The concrete next steps, most immediate first.

## Pointers
Files, commands, tickets and documents the successor needs. Paths and names, not contents.

${PROMPT_TAIL}`;

/** Path of the handoff file for a session: beside the transcript, same stem. */
export function handoffPathFor(
  sessionFile: string | undefined,
  sessionDir: string,
  sessionId: string,
): string {
  if (sessionFile) {
    const dir = path.dirname(sessionFile);
    const stem = path.basename(sessionFile).replace(/\.jsonl$/, "");
    return path.join(dir, `${stem}.handoff.md`);
  }
  return path.join(sessionDir, `${sessionId}.handoff.md`);
}

const GOAL_LINE =
  "A goal is active in this conversation: write the baton so the next conversation stays oriented on that goal.";

export function buildGenerationInput(
  conversationText: string,
  focus: string,
  goalActive = false,
): string {
  const parts = [`## Conversation\n\n${conversationText}`];
  if (focus) parts.push(`## Focus note\n\n${focus}`);
  if (goalActive) parts.push(GOAL_LINE);
  return parts.join("\n\n");
}

/** Bus channel another extension emits a `HandoffRequest` on to hand off now. */
export const HANDOFF_REQUEST_CHANNEL = "handoff:request";

export interface HandoffRequest {
  /** Goes into the baton prompt as the interactive command's focus note does. */
  focus: string;
  /** Where the baton is written; the path beside the transcript when absent. */
  batonPath?: string;
  /** Token count or percentage the caller wants automatic handoff held at. */
  threshold?: string | number;
  goalActive: boolean;
}

/** A bus payload as a request, or undefined when it is not one. */
export function parseHandoffRequest(data: unknown): HandoffRequest | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const { focus, batonPath, threshold, goalActive } = data as Record<string, unknown>;
  if (focus !== undefined && typeof focus !== "string") return undefined;
  if (batonPath !== undefined && typeof batonPath !== "string") return undefined;
  if (
    threshold !== undefined &&
    typeof threshold !== "string" &&
    typeof threshold !== "number"
  ) {
    return undefined;
  }
  if (goalActive !== undefined && typeof goalActive !== "boolean") return undefined;
  return {
    focus: focus ?? "",
    ...(batonPath === undefined ? {} : { batonPath }),
    ...(threshold === undefined ? {} : { threshold }),
    goalActive: goalActive ?? false,
  };
}

/** Bus channel another extension holds automatic handoff on or releases it with. */
export const HANDOFF_AUTO_CHANNEL = "handoff:auto";

export interface AutoForceRequest extends AutoHold {
  /** True holds auto on; false releases the hold. */
  force: boolean;
}

/** A bus payload as an auto hold, or undefined when it is not one. */
export function parseAutoForce(data: unknown): AutoForceRequest | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const { force, at, focus, goalActive, seedEntry, seedDirective } =
    data as Record<string, unknown>;
  if (typeof force !== "boolean") return undefined;
  if (at !== undefined && typeof at !== "string" && typeof at !== "number") {
    return undefined;
  }
  if (focus !== undefined && typeof focus !== "string") return undefined;
  if (goalActive !== undefined && typeof goalActive !== "boolean") {
    return undefined;
  }
  if (seedEntry !== undefined) {
    if (typeof seedEntry !== "object" || seedEntry === null) return undefined;
    if (typeof (seedEntry as { customType?: unknown }).customType !== "string") {
      return undefined;
    }
  }
  if (seedDirective !== undefined && typeof seedDirective !== "string") {
    return undefined;
  }
  return {
    force,
    ...(at === undefined ? {} : { at }),
    ...(focus === undefined ? {} : { focus }),
    ...(goalActive === undefined ? {} : { goalActive }),
    ...(seedEntry === undefined
      ? {}
      : { seedEntry: seedEntry as AutoHold["seedEntry"] }),
    ...(seedDirective === undefined ? {} : { seedDirective }),
  };
}

/** The message that puts the handoff in the new session's context. No path: a
 * named file gets opened instead of read from here. */
export function buildAttachment(handoff: string): string {
  return [
    "Handoff from the previous session. Everything below is the complete handoff; continue from it.",
    "",
    handoff.trim(),
  ].join("\n");
}

/** Editor text after a cancelled handoff: stashed inputs first, then what was typed. */
export function restoreEditorText(stash: string[], current: string): string {
  return [...stash, current].filter((t) => t.trim()).join("\n\n");
}

export function widgetLines(
  stash: string[],
  phase: "armed" | "writing" | "switching" | "idle",
): string[] {
  const status =
    phase === "armed"
      ? "Handoff: armed, runs when the agent settles; Alt+Enter inputs go to the new session"
      : "Handoff: writing… inputs typed now go to the new session";
  return [
    status,
    ...stash.map((text) => `Handoff → ${text}`),
    "↳ /handoff again to cancel and restore them to the editor",
  ];
}

/** A skill or prompt file as system prompt: YAML frontmatter dropped, tail appended. */
export function promptFromFile(text: string): string {
  const body = text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "").trim();
  return `${body}\n\n${PROMPT_TAIL}`;
}

export interface HandoffConfig {
  /** Prompt file, absolute, `~`-prefixed, or relative to the project cwd. */
  promptFile?: string;
  /** Default automatic handoff for every conversation. */
  auto?: AutoConfig;
}

export function resolvePromptFile(
  promptFile: string,
  cwd: string,
  home: string,
): string {
  if (promptFile.startsWith("~/")) return path.join(home, promptFile.slice(2));
  return path.resolve(cwd, promptFile);
}
