/**
 * Background command runner: three tools that start a command detached through
 * the sandboxed bash, wait on it, and kill it.
 *
 * The command's output goes to a log file the agent reads or greps itself.
 * A task that ends on its own wakes the agent with its outcome; tasks belong to
 * the session and are killed with it. The footer extension shows what runs, by
 * reading the list this one publishes on `globalThis`.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { BackgroundRunner, type TaskView } from "./machine.ts";
import { createNodeHost } from "./host.ts";
import { resolveWrap, type Globals, type SandboxWrap } from "./sandbox.ts";

const RunParams = Type.Object({
  command: Type.String({ description: "Shell command to run in the background" }),
});

const WaitParams = Type.Object({
  id: Type.String({ description: "Task id returned by background_run" }),
  marker: Type.Optional(
    Type.String({
      description:
        "Return as soon as this text appears in the log, without waiting for the command to end",
    }),
  ),
});

const KillParams = Type.Object({
  id: Type.String({ description: "Task id returned by background_run" }),
});

export type CodassBackgroundTasks = () => TaskView[];

function publishTasks(list: CodassBackgroundTasks | undefined): void {
  (globalThis as { __codassBackgroundTasks?: CodassBackgroundTasks })
    .__codassBackgroundTasks = list;
}

function text(body: string) {
  return { content: [{ type: "text" as const, text: body }], details: undefined };
}

export default function (pi: ExtensionAPI) {
  let runner: BackgroundRunner | undefined;

  const activeRunner = (): BackgroundRunner => {
    if (!runner) throw new Error("background: no session");
    return runner;
  };

  // Resolved per command, never once per session: extensions load in an
  // arbitrary order, so the sandbox may publish its wrap after this one starts.
  const sandboxedWrap: SandboxWrap = async (command) => {
    const resolved = resolveWrap(globalThis as Globals);
    if ("refusal" in resolved) throw new Error(resolved.refusal);
    return resolved.wrap(command);
  };

  pi.on("session_start", (_event, ctx: ExtensionContext) => {
    runner = new BackgroundRunner(
      createNodeHost({
        cwd: ctx.cwd,
        wrap: sandboxedWrap,
        isIdle: () => ctx.isIdle(),
        sendUserMessage: (body) => pi.sendUserMessage(body),
      }),
    );
    publishTasks(() => runner?.running() ?? []);
  });

  pi.on("agent_settled", () => {
    runner?.flushWakeUps();
  });

  pi.on("session_shutdown", () => {
    runner?.shutdown();
    publishTasks(undefined);
  });

  pi.registerTool({
    name: "background_run",
    label: "background run",
    description:
      "Start a shell command in the background, sandboxed exactly as the bash tool is. Returns at once with a task id and the path of the log the command's output is appended to; read or grep that log yourself. Use background_wait to wait for the command to end or for a marker to appear in its log, and background_kill to stop it.",
    parameters: RunParams,
    async execute(_id, params) {
      const resolved = resolveWrap(globalThis as Globals);
      if ("refusal" in resolved) return text(resolved.refusal);
      const task = activeRunner().run(params.command);
      return text(`Started ${task.id}. Log: ${task.logPath}`);
    },
  });

  pi.registerTool({
    name: "background_wait",
    label: "background wait",
    description:
      "Wait for a background task to end, or for a marker to appear in its log. Returns the outcome and the log path.",
    parameters: WaitParams,
    async execute(_id, params, signal) {
      const result = await activeRunner().wait(params.id, {
        marker: params.marker,
        signal,
      });
      const state =
        result.state === "running"
          ? result.markerFound
            ? `still running, marker found`
            : `still running`
          : result.state === "killed"
            ? "killed"
            : `exited with code ${result.exit?.code ?? "unknown"}${result.exit?.signal ? ` on ${result.exit.signal}` : ""}`;
      return text(
        `${result.id} \`${result.command}\`: ${state}. Log: ${result.logPath}`,
      );
    },
  });

  pi.registerTool({
    name: "background_kill",
    label: "background kill",
    description: "Stop a background task.",
    parameters: KillParams,
    async execute(_id, params) {
      const killed = activeRunner().kill(params.id);
      return text(
        killed
          ? `Killed ${params.id}.`
          : `${params.id} is not running.`,
      );
    },
  });

  pi.registerCommand("background", {
    description: "List the running background tasks",
    handler: async (_args, ctx) => {
      const running = runner?.running() ?? [];
      const resolved = resolveWrap(globalThis as Globals);
      ctx.ui.notify(
        running.length === 0
          ? ("refusal" in resolved
              ? resolved.refusal
              : "No background tasks running")
          : running
              .map((task) => `${task.id} ${task.command} → ${task.logPath}`)
              .join("\n"),
        "info",
      );
    },
  });
}
