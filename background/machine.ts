/**
 * Background task lifecycle, free of any pi or node-process import.
 *
 * The host owns everything that touches the outside world: starting and
 * killing a detached command, reading its log, polling, and waking the agent.
 * A task that ends on its own wakes the agent; one the agent already heard
 * about — through `wait` or `kill` — does not.
 */

export type ExitStatus = { code: number | null; signal: string | null };

export type TaskState = "running" | "exited" | "killed";

export interface TaskView {
  id: string;
  command: string;
  logPath: string;
  state: TaskState;
  exit?: ExitStatus;
}

export interface ProcessHandle {
  kill(): void;
}

export interface BackgroundHost {
  /** Start `command` detached, its output appended to `logPath`. */
  start(
    command: string,
    logPath: string,
    onExit: (status: ExitStatus) => void,
  ): ProcessHandle;
  /** Where the log of a task goes. */
  logPathFor(id: string): string;
  /** The log's bytes from `from` on, and the offset that read ended at. */
  readLog(logPath: string, from: number): { text: string; end: number };
  /** Call `check` repeatedly until the handle is cancelled. */
  watch(check: () => void): { cancel(): void };
  isIdle(): boolean;
  sendUserMessage(text: string): void;
}

export type WaitResult = {
  id: string;
  command: string;
  state: TaskState;
  exit?: ExitStatus;
  logPath: string;
  markerFound: boolean;
};

type Task = TaskView & {
  handle: ProcessHandle;
  /** Set once the outcome has reached the agent, by wake-up or by tool result. */
  reported: boolean;
  onExit: ((status: ExitStatus) => void)[];
};

function outcome(task: Task): string {
  if (task.state === "killed") return "was killed";
  if (task.exit?.signal) return `died on ${task.exit.signal}`;
  return `finished with exit code ${task.exit?.code ?? "unknown"}`;
}

export class BackgroundRunner {
  #host: BackgroundHost;
  #tasks = new Map<string, Task>();
  #pendingWakeUps: string[] = [];
  #counter = 0;
  #stopped = false;

  constructor(host: BackgroundHost) {
    this.#host = host;
  }

  run(command: string): { id: string; logPath: string } {
    const id = `bg${++this.#counter}`;
    const logPath = this.#host.logPathFor(id);
    const task: Task = {
      id,
      command,
      logPath,
      state: "running",
      reported: false,
      onExit: [],
      handle: { kill: () => {} },
    };
    this.#tasks.set(id, task);
    task.handle = this.#host.start(command, logPath, (status) =>
      this.#settle(task, status),
    );
    return { id, logPath };
  }

  async wait(
    id: string,
    options: { marker?: string; signal?: AbortSignal },
  ): Promise<WaitResult> {
    const task = this.#require(id);
    if (task.state !== "running") {
      task.reported = true;
      return this.#result(task, false);
    }

    return new Promise<WaitResult>((resolve) => {
      let watcher: { cancel(): void } | undefined;
      let abandoned = false;
      let settled = false;
      const done = (markerFound: boolean) => {
        if (settled) return;
        settled = true;
        watcher?.cancel();
        // Only a delivered outcome counts as reported: a wait that returned on
        // a marker, or was abandoned, still owes the agent a wake-up.
        if (!abandoned && task.state !== "running") task.reported = true;
        resolve(this.#result(task, markerFound));
      };
      task.onExit.push(() => done(false));
      options.signal?.addEventListener(
        "abort",
        () => {
          abandoned = true;
          done(false);
        },
        { once: true },
      );
      if (options.marker !== undefined) {
        const marker = options.marker;
        let from = 0;
        // Only the bytes appended since the last poll are read; the tail kept
        // from the previous chunk is what a marker straddling two polls needs.
        let carry = "";
        watcher = this.#host.watch(() => {
          const chunk = this.#host.readLog(task.logPath, from);
          from = chunk.end;
          if (chunk.text === "") return;
          const seen = carry + chunk.text;
          if (seen.includes(marker)) done(true);
          else carry = marker.length > 1 ? seen.slice(1 - marker.length) : "";
        });
      }
    });
  }

  kill(id: string): boolean {
    const task = this.#tasks.get(id);
    if (!task || task.state !== "running") return false;
    task.state = "killed";
    task.reported = true;
    task.handle.kill();
    this.#drainExitHandlers(task);
    return true;
  }

  running(): TaskView[] {
    return [...this.#tasks.values()]
      .filter((task) => task.state === "running")
      .map(({ id, command, logPath, state, exit }) => ({
        id,
        command,
        logPath,
        state,
        exit,
      }));
  }

  /** Deliver the wake-ups that piled up while the agent was busy. */
  flushWakeUps(): void {
    if (this.#stopped || this.#pendingWakeUps.length === 0) return;
    const lines = this.#pendingWakeUps.splice(0);
    this.#host.sendUserMessage(this.#wakeUpText(lines));
  }

  /** Kill every live task; the session owns them and they die with it. */
  shutdown(): void {
    this.#stopped = true;
    this.#pendingWakeUps.length = 0;
    for (const task of this.#tasks.values()) {
      if (task.state !== "running") continue;
      task.state = "killed";
      task.reported = true;
      task.handle.kill();
    }
  }

  #wakeUpText(lines: string[]): string {
    return [
      lines.length === 1
        ? "A background task ended."
        : `${lines.length} background tasks ended.`,
      ...lines,
    ].join("\n");
  }

  #settle(task: Task, status: ExitStatus): void {
    if (task.state !== "running") return;
    task.state = "exited";
    task.exit = status;
    this.#drainExitHandlers(task);
    if (task.reported || this.#stopped) return;
    task.reported = true;
    const line = `${task.id} \`${task.command}\` ${outcome(task)}. Log: ${task.logPath}`;
    if (this.#host.isIdle()) {
      this.#host.sendUserMessage(this.#wakeUpText([line]));
    } else {
      this.#pendingWakeUps.push(line);
    }
  }

  #drainExitHandlers(task: Task): void {
    const handlers = task.onExit.splice(0);
    for (const handler of handlers) handler(task.exit ?? { code: null, signal: null });
  }

  #result(task: Task, markerFound: boolean): WaitResult {
    return {
      id: task.id,
      command: task.command,
      state: task.state,
      exit: task.exit,
      logPath: task.logPath,
      markerFound,
    };
  }

  #require(id: string): Task {
    const task = this.#tasks.get(id);
    if (!task) throw new Error(`No background task ${id}`);
    return task;
  }
}
