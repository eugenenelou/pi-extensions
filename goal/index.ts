/**
 * /goal <condition>: work towards a condition until a small model judges it
 * reached, mirroring Claude Code's own `/goal`.
 *
 * The behaviour lives in `machine.ts`; this file builds its host from pi's
 * extension context. After every agent run the judge model reads the goal and
 * the conversation and answers met, not yet, or impossible; a "not yet" reason
 * is sent back as the next run's instruction. While a goal is active it holds
 * automatic handoff on with itself as the focus note, and seeds itself into the
 * successor conversation, so a goal outlives the context that started it.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  CONFIG_DIR_NAME,
  convertToLlm,
  type ExtensionAPI,
  type ExtensionContext,
  getAgentDir,
  type SessionEntry,
  serializeConversation,
} from "@earendil-works/pi-coding-agent";
import { HANDOFF_AUTO_CHANNEL, type AutoForceRequest } from "../handoff/lib.ts";
import { judgeModel } from "../shared/judge.ts";
import {
  GOAL_ENTRY_TYPE,
  type GoalEntry,
  goalFromEntries,
  JUDGE_SYSTEM_PROMPT,
  judgeInput,
  parseGoalCommand,
  parseVerdict,
  resumeDirective,
  statusText,
  type Verdict,
} from "./lib.ts";
import { type GoalHost, GoalMachine } from "./machine.ts";

/** How long the judge is given before its verdict is treated as unanswered. */
const JUDGE_TIMEOUT_MS = 60_000;

/** How long a continuation waits for the session to settle before it is dropped. */
const IDLE_WAIT_MS = 120_000;
const IDLE_POLL_MS = 100;

/**
 * A run is still active while `agent_end` runs, and pi refuses a user message
 * sent into an active run; the extension context has no wait of its own.
 */
function waitForIdle(ctx: ExtensionContext): Promise<boolean> {
  const deadline = Date.now() + IDLE_WAIT_MS;
  return new Promise((resolve) => {
    const check = () => {
      if (ctx.isIdle()) return resolve(true);
      if (Date.now() >= deadline) return resolve(false);
      setTimeout(check, IDLE_POLL_MS);
    };
    check();
  });
}

function branchMessages(branch: SessionEntry[]): AgentMessage[] {
  return branch
    .map((entry) => (entry.type === "message" ? entry.message : undefined))
    .filter((message) => message !== undefined);
}

async function judge(
  ctx: ExtensionContext,
  condition: string,
  conversation: string,
): Promise<Verdict | undefined> {
  const { model, thinking } = judgeModel(ctx, {
    agentDir: getAgentDir(),
    cwd: ctx.cwd,
    configDirName: CONFIG_DIR_NAME,
  });
  if (!model) return undefined;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), JUDGE_TIMEOUT_MS);
  try {
    const response = await ctx.modelRegistry.completeSimple(
      model,
      {
        systemPrompt: JUDGE_SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: judgeInput(condition, conversation) },
            ],
            timestamp: Date.now(),
          },
        ],
      },
      { cacheRetention: "none", reasoning: thinking, signal: controller.signal },
    );
    return parseVerdict(
      response.content
        .filter(
          (block): block is { type: "text"; text: string } =>
            block.type === "text",
        )
        .map((block) => block.text)
        .join("\n"),
    );
  } catch {
    // An unreachable or hung judge leaves the goal armed for the next run.
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

function hostFor(pi: ExtensionAPI, ctx: ExtensionContext): GoalHost {
  const emit = (request: AutoForceRequest) =>
    pi.events.emit(HANDOFF_AUTO_CHANNEL, request);
  return {
    now: () => Date.now() / 1000,
    append: (entry) => pi.appendEntry(GOAL_ENTRY_TYPE, entry),
    send: (text) => pi.sendUserMessage(text, { expandPromptTemplates: true }),
    record: (text) =>
      pi.sendMessage(
        { customType: "goal", content: text, display: true },
        { triggerTurn: false },
      ),
    notify: (message, level) => ctx.ui.notify(message, level),
    waitForIdle: () => waitForIdle(ctx),
    conversation: () => {
      const messages = branchMessages(ctx.sessionManager.getBranch());
      if (messages.length === 0) return undefined;
      return serializeConversation(convertToLlm(messages));
    },
    judge: (condition, conversation) => judge(ctx, condition, conversation),
    // No threshold: automatic handoff runs at the handoff extension's default.
    hold: (focus, seed: GoalEntry) =>
      emit({
        force: true,
        focus,
        goalActive: true,
        seedEntry: { customType: GOAL_ENTRY_TYPE, data: seed },
        // Sent by the handoff, after the baton: the first entry of the
        // successor conversation stays the baton itself.
        ...(seed.condition === null
          ? {}
          : { seedDirective: resumeDirective(seed.condition) }),
      }),
    release: () => emit({ force: false }),
  };
}

export default function (pi: ExtensionAPI) {
  let machine: GoalMachine | undefined;

  pi.on("session_start", async (_event, ctx) => {
    machine = new GoalMachine(hostFor(pi, ctx));
    const entry = goalFromEntries(ctx.sessionManager.getBranch());
    // The hold outlives a session: this factory ran once for the process.
    if (entry) machine.restore(entry);
    else machine.releaseHold();
    // The footer reads the indicator from here; it cannot import this module.
    (globalThis as { __codassGoal?: () => string | undefined }).__codassGoal =
      () => machine?.indicator();
  });

  pi.on("turn_end", async (event) =>
    machine?.turnEnd(event.toolResults.length > 0),
  );

  pi.on("agent_end", async () => {
    // Not awaited: the judge call must not hold pi's agent loop open.
    void machine?.agentEnd();
  });

  pi.on("input", async (event) => {
    if (event.source !== "extension") machine?.userPrompt();
  });

  pi.on("session_shutdown", async () => {
    machine?.releaseHold();
    machine = undefined;
  });

  pi.registerCommand("goal", {
    description: "Work towards a condition until it is met [condition|clear]",
    handler: async (args, ctx) => {
      if (!machine) return;
      const command = parseGoalCommand(args);
      if (command.kind === "status") {
        ctx.ui.notify(statusText(machine.status()), "info");
        return;
      }
      if (command.kind === "clear") {
        const cleared = machine.clear();
        ctx.ui.notify(
          cleared ? `Goal cleared: ${cleared}` : "No goal set",
          "info",
        );
        return;
      }
      machine.set(command.condition);
    },
  });
}
