/** The node side of the background runner: detached processes and their logs. */

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  fstatSync,
  openSync,
  readSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BackgroundHost, ExitStatus, ProcessHandle } from "./machine.ts";
import type { SandboxWrap } from "./sandbox.ts";

const POLL_MS = 250;

export function createNodeHost(deps: {
  cwd: string;
  wrap: SandboxWrap;
  isIdle: () => boolean;
  sendUserMessage: (text: string) => void;
}): BackgroundHost {
  // A session switch reuses the process and restarts the ids at bg1, so the
  // path carries this runner's own token: a new task never lands on the log of
  // a task from a previous session, which stays readable.
  const token = randomBytes(4).toString("hex");

  return {
    logPathFor(id: string): string {
      return join(tmpdir(), `pi-background-${process.pid}-${token}-${id}.log`);
    },

    readLog(logPath: string, from: number): { text: string; end: number } {
      let fd: number;
      try {
        fd = openSync(logPath, "r");
      } catch {
        return { text: "", end: from };
      }
      try {
        const size = fstatSync(fd).size;
        const start = size < from ? 0 : from;
        if (size === start) return { text: "", end: size };
        const buffer = Buffer.alloc(size - start);
        const read = readSync(fd, buffer, 0, buffer.length, start);
        return { text: buffer.toString("utf-8", 0, read), end: start + read };
      } finally {
        closeSync(fd);
      }
    },

    watch(check: () => void) {
      const timer = setInterval(check, POLL_MS);
      timer.unref?.();
      return { cancel: () => clearInterval(timer) };
    },

    isIdle: deps.isIdle,
    sendUserMessage: deps.sendUserMessage,

    start(
      command: string,
      logPath: string,
      onExit: (status: ExitStatus) => void,
    ): ProcessHandle {
      let child: ReturnType<typeof spawn> | undefined;
      let killed = false;

      const killGroup = () => {
        if (!child) return;
        try {
          if (child.pid) process.kill(-child.pid, "SIGKILL");
          else child.kill("SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      };

      void (async () => {
        let wrapped: string;
        try {
          wrapped = await deps.wrap(command);
        } catch (err) {
          appendFileSync(
            logPath,
            `background: could not wrap the command for the sandbox: ${err instanceof Error ? err.message : err}\n`,
          );
          onExit({ code: 127, signal: null });
          return;
        }
        if (killed) {
          onExit({ code: null, signal: "SIGKILL" });
          return;
        }
        const fd = openSync(logPath, "a");
        try {
          // Detached with its own process group, so a kill reaches the whole
          // command tree and the agent exiting does not tear it down midway.
          child = spawn("bash", ["-c", wrapped], {
            cwd: deps.cwd,
            detached: true,
            stdio: ["ignore", fd, fd],
          });
        } finally {
          closeSync(fd);
        }
        child.unref();
        child.on("error", () => onExit({ code: 127, signal: null }));
        child.on("exit", (code, signal) => onExit({ code, signal }));
        if (killed) killGroup();
      })();

      return {
        kill: () => {
          killed = true;
          killGroup();
        },
      };
    },
  };
}
