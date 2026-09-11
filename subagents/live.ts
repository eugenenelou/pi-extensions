/** Live access to one RPC-mode delegated Pi process. */

import type { ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import { homedir } from "node:os";
import * as net from "node:net";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";

export type LiveChildRecord = {
  pid: number;
  sessionId: string;
  parentSessionId: string;
  cwd: string;
  port: number;
  startedAt: number;
  updatedAt: number;
};

type RpcResponse = {
  type: "response";
  id?: string;
  success: boolean;
  data?: unknown;
  error?: string;
};

type PendingRequest = {
  resolve: (response: RpcResponse) => void;
  reject: (error: Error) => void;
};

function attachUtf8Reader(
  stream: NodeJS.ReadableStream,
  read: (chunk: string) => void,
): void {
  const decoder = new StringDecoder("utf8");
  stream.on("data", (data: string | Buffer) =>
    read(typeof data === "string" ? data : decoder.write(data)),
  );
  stream.on("end", () => {
    const trailing = decoder.end();
    if (trailing) read(trailing);
  });
}

function registryDir(): string {
  return (
    process.env.PI_SUBAGENT_REGISTRY_DIR ??
    path.join(homedir(), ".cache", "codass", "pi-subagents")
  );
}

function writeRecord(file: string, record: LiveChildRecord): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.chmodSync(path.dirname(file), 0o700);
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(record), { mode: 0o600 });
    fs.renameSync(`${file}.tmp`, file);
  } catch {
    // Monitoring access must not prevent normal delegation.
  }
}

/**
 * Owns a child process's one RPC channel and exposes that existing runtime over
 * a short-lived local socket. It never creates a second Pi session.
 */
export class LiveChild {
  #proc: ChildProcess;
  #parentSessionId: string;
  #cwd: string;
  #events: Record<string, unknown>[] = [];
  #observers = new Set<net.Socket>();
  #pending = new Map<string, PendingRequest>();
  #buffer = "";
  #nextRequest = 0;
  #running = true;
  #server: net.Server | undefined;
  #port: number | undefined;
  #registryFile: string | undefined;
  #onEvent: (event: Record<string, unknown>) => void;

  constructor(
    proc: ChildProcess,
    parentSessionId: string,
    cwd: string,
    onEvent: (event: Record<string, unknown>) => void,
  ) {
    this.#proc = proc;
    this.#parentSessionId = parentSessionId;
    this.#cwd = cwd;
    this.#onEvent = onEvent;
    if (proc.stdout)
      attachUtf8Reader(proc.stdout, (chunk) => this.#read(chunk));
    proc.on("close", () => this.#stop());
    proc.on("error", () => this.#stop());
  }

  async start(task: string): Promise<void> {
    const state = await this.#request("get_state");
    const sessionId = (state.data as { sessionId?: unknown } | undefined)
      ?.sessionId;
    if (typeof sessionId !== "string")
      throw new Error("Delegated Pi process did not report a session id.");

    const initial = await this.#request("prompt", { message: `Task: ${task}` });
    if (!initial.success)
      throw new Error(initial.error ?? "Delegated Pi process rejected its task.");
    if (!this.#running) return;

    const id = randomUUID();
    const dir = registryDir();
    this.#registryFile = path.join(dir, `${id}.json`);
    await this.#listen();
    if (!this.#running) {
      this.dispose();
      return;
    }
    writeRecord(this.#registryFile, {
      pid: this.#proc.pid ?? process.pid,
      sessionId,
      parentSessionId: this.#parentSessionId,
      cwd: this.#cwd,
      port: this.#port!,
      startedAt: Date.now(),
      updatedAt: Date.now(),
    });
  }

  dispose(): void {
    this.#server?.close();
    this.#server = undefined;
    for (const socket of this.#observers) socket.destroy();
    this.#observers.clear();
  }

  #read(chunk: string): void {
    this.#buffer += chunk;
    const lines = this.#buffer.split("\n");
    this.#buffer = lines.pop() ?? "";
    for (const line of lines) this.#line(line);
  }

  #line(line: string): void {
    if (!line.trim()) return;
    let value: Record<string, unknown>;
    try {
      value = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    if (value.type === "response") {
      const response = value as RpcResponse;
      const id = response.id;
      if (id) {
        const pending = this.#pending.get(id);
        if (pending) {
          this.#pending.delete(id);
          pending.resolve(response);
        }
      }
      return;
    }
    this.#events.push(value);
    this.#onEvent(value);
    this.#broadcast({ type: "event", event: value });
    if (value.type === "agent_settled") this.#stop();
  }

  #request(type: string, args: Record<string, unknown> = {}): Promise<RpcResponse> {
    if (!this.#running || !this.#proc.stdin?.writable)
      return Promise.resolve({ type: "response", success: false, error: "Child is no longer running." });
    const id = `live-${++this.#nextRequest}`;
    return new Promise<RpcResponse>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#proc.stdin!.write(`${JSON.stringify({ id, type, ...args })}\n`, (error) => {
        if (!error) return;
        this.#pending.delete(id);
        reject(error);
      });
    });
  }

  async #listen(): Promise<void> {
    this.#server = net.createServer((socket) => this.#observe(socket));
    await new Promise<void>((resolve, reject) => {
      this.#server!.once("error", reject);
      this.#server!.listen({ host: "127.0.0.1", port: 0 }, () => {
        this.#server!.off("error", reject);
        const address = this.#server!.address();
        if (!address || typeof address === "string") {
          reject(new Error("Could not allocate live-child port."));
          return;
        }
        this.#port = address.port;
        resolve();
      });
    });
  }

  #observe(socket: net.Socket): void {
    this.#observers.add(socket);
    let buffer = "";
    attachUtf8Reader(socket, (chunk) => {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) void this.#observerLine(socket, line);
    });
    socket.on("close", () => this.#observers.delete(socket));
  }

  async #observerLine(socket: net.Socket, line: string): Promise<void> {
    let command: { type?: unknown; id?: unknown; text?: unknown };
    try {
      command = JSON.parse(line) as typeof command;
    } catch {
      return;
    }
    if (command.type === "observe") {
      this.#send(socket, { type: "snapshot", events: this.#events });
      if (!this.#running) this.#send(socket, { type: "closed" });
      return;
    }
    if (command.type !== "message" || typeof command.id !== "string" || typeof command.text !== "string")
      return;
    if (!this.#running) {
      this.#send(socket, {
        type: "response",
        id: command.id,
        success: false,
        error: "Child is no longer running.",
      });
      return;
    }
    try {
      const response = await this.#request("prompt", {
        message: command.text,
        streamingBehavior: "steer",
      });
      this.#send(socket, {
        type: "response",
        id: command.id,
        success: response.success,
        ...(response.success ? {} : { error: response.error ?? "Child is no longer running." }),
      });
    } catch {
      this.#send(socket, {
        type: "response",
        id: command.id,
        success: false,
        error: "Child is no longer running.",
      });
    }
  }

  #send(socket: net.Socket, value: Record<string, unknown>): void {
    if (!socket.destroyed) socket.write(`${JSON.stringify(value)}\n`);
  }

  #broadcast(value: Record<string, unknown>): void {
    for (const socket of this.#observers) this.#send(socket, value);
  }

  #stop(): void {
    if (!this.#running) return;
    this.#running = false;
    if (this.#registryFile) fs.rmSync(this.#registryFile, { force: true });
    this.#broadcast({ type: "closed" });
    for (const pending of this.#pending.values())
      pending.resolve({ type: "response", success: false, error: "Child is no longer running." });
    this.#pending.clear();
    // Leave current observers a brief opportunity to receive the required
    // post-exit response; the registry is already gone, so new access is not.
    setTimeout(() => this.dispose(), 1000).unref();
    this.#proc.stdin?.end();
    setTimeout(() => {
      if (!this.#proc.killed) this.#proc.kill("SIGTERM");
    }, 100).unref();
  }
}
