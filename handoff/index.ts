/**
 * /handoff [focus note]: write a forward-looking handoff beside the session
 * transcript and continue in a new session with it in context.
 *
 * The behaviour lives in `machine.ts`; this file builds its host from pi's
 * extension context. Typed while the agent is running, the command arms and
 * waits for the agent to settle; inputs typed for the new session are captured
 * and replayed there. /handoff again cancels and restores them to the editor.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { type Message, uuidv7 } from "@earendil-works/pi-ai";
import {
  CONFIG_DIR_NAME,
  convertToLlm,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
  getAgentDir,
  type SessionEntry,
  serializeConversation,
} from "@earendil-works/pi-coding-agent";
import { Container, Spacer, Text } from "@earendil-works/pi-tui";
import {
  AUTO_ENTRY_TYPE,
  AutoHandoff,
  type AutoHold,
  type AutoSetting,
  parseAutoCommand,
  settingFromEntries,
} from "./auto.ts";
import {
  HANDOFF_AUTO_CHANNEL,
  HANDOFF_REQUEST_CHANNEL,
  HANDOFF_SYSTEM_PROMPT,
  type HandoffConfig,
  type HandoffRequest,
  handoffPathFor,
  mergeHandoffConfig,
  parseAutoForce,
  parseHandoffRequest,
  promptFromFile,
} from "./lib.ts";
import { HandoffMachine, headlessHost, type Host } from "./machine.ts";

const WIDGET_KEY = "handoff";

function readJson(file: string): HandoffConfig {
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    return {};
  }
}

/** Global `~/.pi/agent/extensions/handoff.json` under project `.pi/handoff.json`. */
function loadConfig(cwd: string): HandoffConfig {
  const agentDir = getAgentDir();
  return mergeHandoffConfig(
    readJson(path.join(agentDir, "extensions", "handoff.json")),
    readJson(path.join(cwd, CONFIG_DIR_NAME, "handoff.json")),
    { agentDir, cwd, home: os.homedir() },
  );
}

/** The configured prompt file, or the built-in prompt when none is set or readable. */
function systemPrompt(ctx: ExtensionContext): string {
  const { promptFile: file } = loadConfig(ctx.cwd);
  if (!file) return HANDOFF_SYSTEM_PROMPT;
  try {
    return promptFromFile(fs.readFileSync(file, "utf-8"));
  } catch (err) {
    ctx.ui.notify(
      `handoff: cannot read promptFile ${file} (${(err as Error).message}); using the built-in prompt`,
      "warning",
    );
    return HANDOFF_SYSTEM_PROMPT;
  }
}

function entryToMessage(entry: SessionEntry): AgentMessage | undefined {
  if (entry.type === "message") return entry.message;
  if (entry.type === "compaction") {
    return {
      role: "compactionSummary",
      summary: entry.summary,
      tokensBefore: entry.tokensBefore,
      timestamp: new Date(entry.timestamp).getTime(),
    };
  }
  return undefined;
}

/** Messages of the current branch; after a compaction, the summary plus what it kept. */
function branchMessages(branch: SessionEntry[]): AgentMessage[] {
  const compactionIndex = branch.findLastIndex((e) => e.type === "compaction");
  if (compactionIndex < 0) {
    return branch.map(entryToMessage).filter((m) => m !== undefined);
  }
  const compaction = branch[compactionIndex];
  const firstKeptIndex =
    compaction.type === "compaction"
      ? branch.findIndex((e) => e.id === compaction.firstKeptEntryId)
      : -1;
  return [
    compaction,
    ...(firstKeptIndex >= 0
      ? branch.slice(firstKeptIndex, compactionIndex)
      : []),
    ...branch.slice(compactionIndex + 1),
  ]
    .map(entryToMessage)
    .filter((m) => m !== undefined);
}

function setWidget(ctx: ExtensionContext, lines: string[] | undefined): void {
  if (lines === undefined) {
    ctx.ui.setWidget(WIDGET_KEY, undefined);
    return;
  }
  ctx.ui.setWidget(WIDGET_KEY, (_tui, theme) => {
    const container = new Container();
    container.addChild(new Spacer(1));
    for (const line of lines) {
      container.addChild(new Text(theme.fg("dim", line), 1, 0));
    }
    return container;
  });
}

function hostFor(
  ctx: ExtensionCommandContext,
  setting: AutoSetting | undefined,
  hold: AutoHold | undefined,
): Host {
  return {
    isIdle: () => ctx.isIdle(),
    waitForIdle: () => ctx.waitForIdle(),
    notify: (message, level) => ctx.ui.notify(message, level),
    setWidget: (lines) => setWidget(ctx, lines),
    getEditorText: () => ctx.ui.getEditorText(),
    setEditorText: (text) => ctx.ui.setEditorText(text),
    conversation: () => {
      const messages = branchMessages(ctx.sessionManager.getBranch());
      if (messages.length === 0) return undefined;
      return serializeConversation(convertToLlm(messages));
    },
    systemPrompt: () => systemPrompt(ctx),
    complete: async (prompt, input, signal) => {
      const userMessage: Message = {
        role: "user",
        content: [{ type: "text", text: input }],
        timestamp: Date.now(),
      };
      const response = await ctx.modelRegistry.complete(
        ctx.model!,
        { systemPrompt: prompt, messages: [userMessage] },
        { signal, cacheRetention: "none", sessionId: uuidv7() },
      );
      if (response.stopReason === "aborted") return null;
      if (response.stopReason === "error") {
        throw new Error(response.errorMessage || "model error");
      }
      const text = response.content
        .filter((c): c is { type: "text"; text: string } => c.type === "text")
        .map((c) => c.text)
        .join("\n")
        .trim();
      return text || null;
    },
    resumeMessage: () => hold?.seedDirective,
    handoffPath: () =>
      handoffPathFor(
        ctx.sessionManager.getSessionFile(),
        ctx.sessionManager.getSessionDir(),
        ctx.sessionManager.getSessionId(),
      ),
    writeFile: (file, text) => {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, text);
    },
    newSession: (withSession) =>
      ctx.newSession({
        parentSession: ctx.sessionManager.getSessionFile(),
        // The successor is a fresh session file: the conversation's auto
        // setting only carries over if it is written into it.
        setup: async (sessionManager) => {
          if (setting) sessionManager.appendCustomEntry(AUTO_ENTRY_TYPE, setting);
          // The holder re-arms itself from this entry in the successor.
          if (hold?.seedEntry) {
            sessionManager.appendCustomEntry(
              hold.seedEntry.customType,
              hold.seedEntry.data,
            );
          }
        },
        withSession: async (next) => {
          await withSession({
            // Idle session, no trigger: appended at once, so the handoff is
            // the first entry of the new conversation.
            appendMessage: (text) =>
              next.sendMessage(
                { customType: "handoff", content: text, display: true },
                { triggerTurn: false },
              ),
            clearWidget: () => next.ui.setWidget(WIDGET_KEY, undefined),
            sendUserMessage: (text) =>
              next.sendUserMessage(text, { expandPromptTemplates: true }),
            notify: (message, level) => next.ui.notify(message, level),
          });
        },
      }),
  };
}

export default function (pi: ExtensionAPI) {
  const machine = new HandoffMachine();
  let auto = new AutoHandoff();
  /** Set by a bus request, consumed by the command run it dispatches. */
  let requested: HandoffRequest | undefined;

  /** The bus hands out no command context, and the machine needs one for the
   * session switch. Dispatching the command gets one without starting a turn. */
  function run(request: HandoffRequest): void {
    if (requested || machine.phase !== "idle") return;
    requested = request;
    pi.sendUserMessage("/handoff", { expandPromptTemplates: true });
  }

  pi.events.on(HANDOFF_REQUEST_CHANNEL, (data) => {
    const request = parseHandoffRequest(data);
    if (!request) return;
    if (request.threshold !== undefined) {
      auto.force({ ...auto.hold(), at: request.threshold });
    }
    run(request);
  });

  pi.events.on(HANDOFF_AUTO_CHANNEL, (data) => {
    const hold = parseAutoForce(data);
    if (!hold) return;
    if (hold.force) auto.force(hold);
    else auto.release();
  });

  pi.on("session_start", async (_event, ctx) => {
    // Extensions get `session_start` in load order, so a hold placed by one that
    // loads earlier must survive the rebuild of this conversation's setting.
    const hold = auto.hold();
    auto = new AutoHandoff(loadConfig(ctx.cwd).auto);
    if (hold) auto.force(hold);
    const setting = settingFromEntries(ctx.sessionManager.getBranch());
    if (setting) auto.restore(setting);
    // The footer reads the indicator from here; it cannot import this module.
    (globalThis as { __codassHandoffAuto?: () => string | undefined })
      .__codassHandoffAuto = () => auto.indicator();
  });

  pi.on("turn_end", async (_event, ctx) => {
    if (!auto.shouldHandoff(ctx.getContextUsage())) return;
    const hold = auto.hold();
    run({ focus: hold?.focus ?? "", goalActive: hold?.goalActive ?? false });
  });

  pi.on("input", async (event) => {
    return machine.onInput(event.text, event.streamingBehavior)
      ? { action: "handled" }
      : { action: "continue" };
  });

  pi.on("session_shutdown", async () => machine.onSessionShutdown());

  pi.registerCommand("handoff", {
    description:
      "Write a handoff file and continue in a new session [focus note]",
    handler: async (args, ctx) => {
      const request = requested;
      requested = undefined;
      const command = request ? undefined : parseAutoCommand(args);
      if (command) {
        if (command.kind === "invalid") {
          ctx.ui.notify(
            `handoff auto: ${command.at} is neither a token count nor a percentage`,
            "error",
          );
          return;
        }
        const setting = auto.apply(command);
        if (setting) pi.appendEntry(AUTO_ENTRY_TYPE, setting);
        const indicator = auto.indicator();
        ctx.ui.notify(
          indicator ? `Automatic handoff: ${indicator}` : "Automatic handoff off",
          "info",
        );
        return;
      }
      if (!request && ctx.mode !== "tui") {
        ctx.ui.notify("handoff requires interactive mode", "error");
        return;
      }
      if (!ctx.model) {
        ctx.ui.notify("No model selected", "error");
        return;
      }
      const host = hostFor(ctx, auto.setting(), auto.hold());
      // Not awaited: pi's input loop waits for this handler, and inputs typed
      // while it runs would be held back from the input event.
      void (request
        ? machine.request(
            headlessHost(host, request.batonPath),
            request.focus,
            request.goalActive,
          )
        : machine.command(host, args.trim()));
    },
  });
}
