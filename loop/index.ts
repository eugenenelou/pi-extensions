/**
 * A pi session that runs a codass supervised loop by itself.
 *
 * Inert unless codass spawned the session with the loop env (`CODASS_LOOP`,
 * `LOOP_SKILL`, `HANDOFF_PATH` and a cadence or cron expression): nothing is
 * registered and no timer runs. With it, this session owns the clock — codass
 * only keeps the process alive — ticking the loop's skill when due and idle,
 * counting its generation's ticks, and handing over to a fresh conversation in
 * the same process once a threshold is crossed.
 *
 * The behaviour lives in `machine.ts`; this file builds its host from pi's
 * extension context and reads and writes the three files under codass's loop
 * cache dir that its monitor also reads.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { HANDOFF_REQUEST_CHANNEL } from "../handoff/lib.ts";
import {
  batonArchivePath,
  iterationCounterPath,
  lastTickPath,
  type LoopConfig,
  parseLoopEnv,
  staleArchives,
} from "./lib.ts";
import { type LoopHost, LoopMachine } from "./machine.ts";

/** How often the clock is consulted; also how fast a deleted stamp forces a tick. */
const POLL_MS = 5000;

function readNumber(file: string): number | null {
  try {
    const value = Number(fs.readFileSync(file, "utf-8").trim());
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

function write(file: string, text: string): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  } catch {
    // The cache dir is codass's; a loop that cannot stamp still ticks.
  }
}

/**
 * Retire the baton the predecessor generation wrote, as codass's own baton
 * consumer does: the successor already carries its content in context, and a
 * live file still on disk reads to codass as a cutover in flight.
 */
function archiveBaton(batonPath: string): void {
  try {
    fs.renameSync(batonPath, batonArchivePath(batonPath, new Date()));
  } catch {
    return; // nothing was handed off
  }
  const dir = path.dirname(batonPath);
  try {
    for (const name of staleArchives(fs.readdirSync(dir))) {
      fs.rmSync(path.join(dir, name), { force: true });
    }
  } catch {
    // Pruning is housekeeping; the cutover already happened.
  }
}

function hostFor(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  config: LoopConfig,
): LoopHost {
  const stamp = lastTickPath(config.batonPath);
  const counter = iterationCounterPath(
    config.batonPath,
    ctx.sessionManager.getSessionId(),
  );
  return {
    now: () => Date.now() / 1000,
    isIdle: () => ctx.isIdle(),
    readLastTick: () => readNumber(stamp),
    stampLastTick: (epoch) => write(stamp, String(epoch)),
    readIterations: () => readNumber(counter) ?? 0,
    writeIterations: (count) => write(counter, String(count)),
    contextTokens: () => ctx.getContextUsage()?.tokens ?? null,
    // Only starts a turn when the agent is idle, which the machine checked.
    sendTick: (text) =>
      pi.sendUserMessage(text, { expandPromptTemplates: true }),
    requestHandoff: (request) =>
      pi.events.emit(HANDOFF_REQUEST_CHANNEL, {
        ...request,
        goalActive: false,
      }),
  };
}

export default function (pi: ExtensionAPI) {
  const config = parseLoopEnv(process.env);
  if (!config) return;

  let machine: LoopMachine | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  /** Set once this process has had a session: the next one is a cutover's successor. */
  let previousCounter: string | undefined;

  function stopTimer(): void {
    if (timer) clearInterval(timer);
    timer = undefined;
  }

  // Per session, not per process: the successor conversation of a cutover gets
  // its own machine, so its iteration count starts from its own counter file.
  pi.on("session_start", async (_event, ctx) => {
    stopTimer();
    if (previousCounter !== undefined) {
      archiveBaton(config.batonPath);
      fs.rmSync(previousCounter, { force: true });
    }
    previousCounter = iterationCounterPath(
      config.batonPath,
      ctx.sessionManager.getSessionId(),
    );
    machine = new LoopMachine(config, hostFor(pi, ctx, config));
    machine.start();
    timer = setInterval(() => machine?.poll(), POLL_MS);
  });

  // Once per run, not per assistant message: a tick is one run, however many
  // tool rounds it takes, and codass's counters mean the same thing.
  pi.on("agent_end", async () => machine?.agentEnd());

  pi.on("session_shutdown", async () => {
    stopTimer();
    machine = undefined;
  });
}
