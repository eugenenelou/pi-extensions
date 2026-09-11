import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { LiveChild, type ExtensionUiRequest, type ExtensionUiResponse } from "./live.ts";

export interface TempFile {
  dir: string;
  filePath: string;
}

export interface ExecutionChild {
  onEvent(listener: (event: Record<string, unknown>) => void): void;
  onStderr(listener: (text: string) => void): void;
  start(task: string): Promise<void>;
  waitForExit(): Promise<number>;
  terminate(signal: NodeJS.Signals): void;
  hasExited(): boolean;
}

export interface ProcessHost {
  createTempFile(prefix: string, name: string, content: string): Promise<TempFile>;
  removeTemp(temp: TempFile): void;
  resolveCwd(defaultCwd: string, cwd: string | undefined): string;
  spawn(options: {
    args: string[];
    cwd: string;
    parentSessionId: string;
    env?: Record<string, string>;
    onUiRequest?: (
      request: ExtensionUiRequest,
      signal: AbortSignal,
    ) => Promise<ExtensionUiResponse>;
  }): ExecutionChild;
}

async function createTempFile(
  prefix: string,
  name: string,
  content: string,
): Promise<TempFile> {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), prefix));
  const filePath = path.join(dir, name.replace(/[^\w.-]+/g, "_"));
  await withFileMutationQueue(filePath, async () => {
    await fs.promises.writeFile(filePath, content, {
      encoding: "utf-8",
      mode: 0o600,
    });
  });
  return { dir, filePath };
}

function removeTemp(temp: TempFile): void {
  try {
    fs.unlinkSync(temp.filePath);
  } catch {
    /* ignore */
  }
  try {
    fs.rmdirSync(temp.dir);
  } catch {
    /* ignore */
  }
}

function findPiOnDisk(): string | null {
  const candidates = [
    ...(process.env.PATH ?? "")
      .split(path.delimiter)
      .filter(Boolean)
      .map((dir) => path.join(dir, "pi")),
    path.join(os.homedir(), ".local", "share", "pnpm", "pi"),
  ];
  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      /* keep looking */
    }
  }
  return null;
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
  const currentScript = process.argv[1];
  const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
  if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
    return { command: process.execPath, args: [currentScript, ...args] };
  }

  const execName = path.basename(process.execPath).toLowerCase();
  if (!/^(node|bun)(\.exe)?$/.test(execName))
    return { command: process.execPath, args };

  return { command: findPiOnDisk() ?? "pi", args };
}

class NodeExecutionChild implements ExecutionChild {
  #proc: ChildProcess;
  #live: LiveChild;
  #onEvent: ((event: Record<string, unknown>) => void) | undefined;
  #exit: Promise<number>;
  #exited = false;

  constructor(
    proc: ChildProcess,
    parentSessionId: string,
    cwd: string,
    onUiRequest?: (
      request: ExtensionUiRequest,
      signal: AbortSignal,
    ) => Promise<ExtensionUiResponse>,
  ) {
    this.#proc = proc;
    this.#live = new LiveChild(proc, parentSessionId, cwd, (event) =>
      this.#onEvent?.(event),
      onUiRequest,
    );
    this.#exit = new Promise<number>((resolve) => {
      proc.on("close", (code) => {
        this.#exited = true;
        resolve(code ?? 0);
      });
      proc.on("error", () => {
        this.#exited = true;
        resolve(1);
      });
    });
  }

  onEvent(listener: (event: Record<string, unknown>) => void): void {
    this.#onEvent = listener;
  }

  onStderr(listener: (text: string) => void): void {
    this.#proc.stderr?.on("data", (data) => listener(data.toString()));
  }

  start(task: string): Promise<void> {
    return this.#live.start(task);
  }

  waitForExit(): Promise<number> {
    return this.#exit;
  }

  terminate(signal: NodeJS.Signals): void {
    this.#proc.kill(signal);
  }

  hasExited(): boolean {
    return this.#exited;
  }
}

export const nodeProcessHost: ProcessHost = {
  createTempFile,
  removeTemp,
  resolveCwd: (defaultCwd, cwd) => path.resolve(defaultCwd, cwd ?? "."),
  spawn({ args, cwd, parentSessionId, env, onUiRequest }) {
    const invocation = getPiInvocation(args);
    const proc = spawn(invocation.command, invocation.args, {
      cwd,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...env, PI_SUBAGENT_PARENT_SESSION_ID: parentSessionId },
    });
    return new NodeExecutionChild(proc, parentSessionId, cwd, onUiRequest);
  },
};
