/**
 * Sandbox Extension - OS-level sandboxing for bash commands
 *
 * Uses @anthropic-ai/sandbox-runtime to enforce filesystem and network
 * restrictions on bash commands at the OS level (sandbox-exec on macOS,
 * bubblewrap on Linux).
 *
 * Note: this example intentionally overrides the built-in `bash` tool to show
 * how built-in tools can be replaced. Alternatively, you could sandbox `bash`
 * via `tool_call` input mutation without replacing the tool.
 *
 * Config files (merged, project takes precedence):
 * - ~/.pi/agent/extensions/sandbox.json (global)
 * - <cwd>/.pi/sandbox.json (project-local)
 *
 * Example .pi/sandbox.json:
 * ```json
 * {
 *   "enabled": true,
 *   "network": {
 *     "allowedDomains": ["github.com", "*.github.com"],
 *     "deniedDomains": []
 *   },
 *   "filesystem": {
 *     "denyRead": ["~/.ssh", "~/.aws"],
 *     "allowWrite": [".", "/tmp"],
 *     "denyWrite": [".env"]
 *   }
 * }
 * ```
 *
 * Usage:
 * - `pi -e ./sandbox` - sandbox enabled with default/config settings
 * - `pi -e ./sandbox --no-sandbox` - disable sandboxing
 * - `/sandbox` - show current sandbox configuration
 *
 * Setup:
 * 1. Copy sandbox/ directory to ~/.pi/agent/extensions/
 * 2. Run `npm install` in ~/.pi/agent/extensions/sandbox/
 *
 * Linux requires bubblewrap and ripgrep. socat is only needed when a domain
 * allowlist is configured; without one the network is left unrestricted and
 * the socat-based proxy bridge is never built.
 */

import { randomBytes } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  SandboxManager,
  type SandboxRuntimeConfig,
} from "@anthropic-ai/sandbox-runtime";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  type BashOperations,
  CONFIG_DIR_NAME,
  createBashTool,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";

type FilesystemConfig = Partial<SandboxRuntimeConfig["filesystem"]> & {
  /**
   * Paths kept visible inside a `denyRead` subtree. The runtime has no such
   * key: it is applied here by reordering the bwrap argv (see
   * `applyAllowRead`), so `denyRead: ["~/"]` can hide the whole home directory
   * while a handful of tool directories stay readable.
   */
  allowRead?: string[];
};

interface SandboxConfig extends Omit<
  SandboxRuntimeConfig,
  "network" | "filesystem"
> {
  enabled?: boolean;
  network?: Partial<SandboxRuntimeConfig["network"]>;
  filesystem?: FilesystemConfig;
  trace?: boolean;
}

/**
 * `network.allowedDomains` left undefined is the only way to get an
 * unrestricted network out of @anthropic-ai/sandbox-runtime: it is what makes
 * the runtime skip network restriction entirely (an empty array means "deny
 * all"). The upstream example ships an npm/pypi/github allowlist here instead.
 */
const DEFAULT_CONFIG: SandboxConfig = {
  enabled: true,
  network: {},
  filesystem: {
    denyRead: ["~/.ssh", "~/.aws", "~/.gnupg"],
    allowWrite: [".", "/tmp"],
    denyWrite: [".env", ".env.*", "*.pem", "*.key"],
  },
};

function loadConfig(cwd: string): SandboxConfig {
  const projectConfigPath = join(cwd, CONFIG_DIR_NAME, "sandbox.json");
  const globalConfigPath = join(getAgentDir(), "extensions", "sandbox.json");

  let globalConfig: Partial<SandboxConfig> = {};
  let projectConfig: Partial<SandboxConfig> = {};

  if (existsSync(globalConfigPath)) {
    try {
      globalConfig = JSON.parse(readFileSync(globalConfigPath, "utf-8"));
    } catch (e) {
      console.error(`Warning: Could not parse ${globalConfigPath}: ${e}`);
    }
  }

  if (existsSync(projectConfigPath)) {
    try {
      projectConfig = JSON.parse(readFileSync(projectConfigPath, "utf-8"));
    } catch (e) {
      console.error(`Warning: Could not parse ${projectConfigPath}: ${e}`);
    }
  }

  return deepMerge(deepMerge(DEFAULT_CONFIG, globalConfig), projectConfig);
}

function deepMerge(
  base: SandboxConfig,
  overrides: Partial<SandboxConfig>,
): SandboxConfig {
  const result: SandboxConfig = { ...base };

  if (overrides.enabled !== undefined) result.enabled = overrides.enabled;
  if (overrides.network) {
    result.network = { ...base.network, ...overrides.network };
  }
  if (overrides.filesystem) {
    result.filesystem = { ...base.filesystem, ...overrides.filesystem };
  }
  if (overrides.trace !== undefined) result.trace = overrides.trace;

  const extOverrides = overrides as {
    ignoreViolations?: Record<string, string[]>;
    enableWeakerNestedSandbox?: boolean;
  };
  const extResult = result as {
    ignoreViolations?: Record<string, string[]>;
    enableWeakerNestedSandbox?: boolean;
  };

  if (extOverrides.ignoreViolations) {
    extResult.ignoreViolations = extOverrides.ignoreViolations;
  }
  if (extOverrides.enableWeakerNestedSandbox !== undefined) {
    extResult.enableWeakerNestedSandbox =
      extOverrides.enableWeakerNestedSandbox;
  }

  return result;
}

/**
 * bwrap creates a missing `--ro-bind` target as a read-only empty file, so every
 * deny path the runtime lists but the project does not have (`.bashrc`, `.env`,
 * `.idea`, …) is materialised as 0-byte litter in the working directory. Dropping
 * the binds whose target does not exist loses nothing: there is no file to hide.
 */
function dropMissingDevNullBinds(command: string): string {
  if (!command.startsWith("bwrap ")) return command;

  const sep = command.search(/ -- (?!-)/);
  const argv = sep === -1 ? command : command.slice(0, sep);
  const rest = sep === -1 ? "" : command.slice(sep);

  const filtered = argv.replace(
    /--(?:ro-)?bind \/dev\/null ((?:\\.|[^\s])+) ?/g,
    (match, target: string) => {
      const path = target.replace(/\\(.)/g, "$1");
      return existsSync(path) ? match : "";
    },
  );

  return filtered + rest;
}

const HOME = homedir();

/** Absolute path for a config entry, expanding a leading `~`. */
function expandPath(pathPattern: string): string {
  if (pathPattern === "~") return HOME;
  if (pathPattern.startsWith("~/")) return join(HOME, pathPattern.slice(2));
  return resolve(pathPattern);
}

function shellQuote(value: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value)
    ? value
    : `'${value.replace(/'/g, `'\\''`)}'`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Re-expose `filesystem.allowRead` paths inside a home directory hidden by
 * `denyRead`.
 *
 * bwrap applies mounts in argv order, and the runtime emits read denies last —
 * a `--tmpfs ~` would therefore bury the worktree bind that precedes it. The
 * tmpfs is moved to the front of the filesystem mounts, the allowRead paths are
 * bound read-only right after it, and every write bind and deny the runtime
 * produced keeps its place behind them.
 */
function applyAllowRead(command: string, filesystem: FilesystemConfig): string {
  if (!command.startsWith("bwrap ")) return command;

  const sep = command.search(/ -- (?!-)/);
  const argv = sep === -1 ? command : command.slice(0, sep);
  const rest = sep === -1 ? "" : command.slice(sep);

  const homeTmpfs = new RegExp(
    `--tmpfs ${escapeRegExp(shellQuote(HOME))}\\/? `,
    "g",
  );
  if (!homeTmpfs.test(argv)) return command;

  // Parents first: a later parent bind would shadow the child mounted before it.
  const allowRead = [...new Set((filesystem.allowRead ?? []).map(expandPath))]
    .filter(existsSync)
    .sort((a, b) => a.length - b.length);

  const mounts = [
    `--tmpfs ${shellQuote(HOME)} `,
    ...allowRead.map(
      (path) => `--ro-bind ${shellQuote(path)} ${shellQuote(path)} `,
    ),
  ].join("");

  const root = "--ro-bind / / ";
  const rootAt = argv.indexOf(root);
  if (rootAt === -1) return command;
  const insertAt = rootAt + root.length;

  const rebuilt =
    argv.slice(0, insertAt) +
    mounts +
    argv.slice(insertAt).replace(homeTmpfs, "");

  return rebuilt + rest;
}

const DENIAL_PATTERNS = [
  /Read-only file system/,
  /Permission denied/,
  /No such file or directory/,
  /Operation not permitted/,
];
const MAX_DENIAL_LINES = 10;
const MAX_TRACE_LINES = 200;

function denialLog(): string {
  return join(getAgentDir(), "sandbox-denials.log");
}

function logDenial(entry: Record<string, unknown>): void {
  try {
    appendFileSync(
      denialLog(),
      `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`,
    );
  } catch {
    // A log the agent cannot write must never fail the command.
  }
}

/** Output lines that read like the sandbox refused a path. */
function denialLines(output: string): string[] {
  const seen = new Set<string>();
  for (const raw of output.split("\n")) {
    const line = raw.trim();
    if (!line || !DENIAL_PATTERNS.some((pattern) => pattern.test(line)))
      continue;
    seen.add(line);
    if (seen.size >= MAX_DENIAL_LINES) break;
  }
  return [...seen];
}

/** Append the strace output of a finished command to the denial log. */
function recordTrace(capture: ExecCapture, cwd: string, command: string): void {
  const path = capture.tracePath;
  if (!path || !existsSync(path)) return;
  let lines: string[] = [];
  try {
    lines = readFileSync(path, "utf-8").split("\n").filter(Boolean);
  } catch {
    return;
  }
  if (lines.length === 0) return;
  logDenial({
    cwd,
    command,
    trace: true,
    tracePath: path,
    lines: lines.slice(0, MAX_TRACE_LINES),
  });
}

let straceChecked = false;
let straceAvailable = false;

function hasStrace(): boolean {
  if (!straceChecked) {
    straceChecked = true;
    straceAvailable =
      spawnSync("which", ["strace"], { stdio: "ignore", timeout: 1000 })
        .status === 0;
  }
  return straceAvailable;
}

type ExecCapture = { denials: string[]; tracePath?: string };

/**
 * Finished executions waiting for their `tool_result`. The bash tool result is
 * assembled outside this extension — the registered tool's own `execute` is not
 * what runs the command — so the hint is attached to the event instead.
 */
const pendingCaptures: { command: string; capture: ExecCapture }[] = [];

function takeCapture(command: string | undefined): ExecCapture | undefined {
  const index = pendingCaptures.findIndex((entry) => entry.command === command);
  const [entry] = pendingCaptures.splice(index === -1 ? 0 : index, 1);
  return entry?.capture;
}

function createSandboxedBashOps(
  trace: boolean,
  filesystem: FilesystemConfig,
): BashOperations {
  return {
    async exec(command, cwd, { onData, signal, timeout }) {
      if (!existsSync(cwd)) {
        throw new Error(`Working directory does not exist: ${cwd}`);
      }
      const capture: ExecCapture = { denials: [] };

      let inner = command;
      if (trace && hasStrace()) {
        // /tmp is writable inside the jail and shared with the host, so the
        // agent process can read the trace back after the command exits.
        const tracePath = join(
          tmpdir(),
          `pi-sandbox-trace-${randomBytes(6).toString("hex")}.log`,
        );
        capture.tracePath = tracePath;
        inner = `strace -f -e trace=file -e status=failed -o ${shellQuote(tracePath)} bash -c ${shellQuote(command)}`;
      }

      const wrappedCommand = applyAllowRead(
        dropMissingDevNullBinds(await SandboxManager.wrapWithSandbox(inner)),
        filesystem,
      );

      return new Promise((resolve, reject) => {
        // Both streams: a wrapper like rtk reports the refusal on stdout.
        let output = "";
        const child = spawn("bash", ["-c", wrappedCommand], {
          cwd,
          detached: true,
          stdio: ["ignore", "pipe", "pipe"],
        });

        let timedOut = false;
        let timeoutHandle: NodeJS.Timeout | undefined;

        if (timeout !== undefined && timeout > 0) {
          timeoutHandle = setTimeout(() => {
            timedOut = true;
            if (child.pid) {
              try {
                process.kill(-child.pid, "SIGKILL");
              } catch {
                child.kill("SIGKILL");
              }
            }
          }, timeout * 1000);
        }

        const capturing = (data: Buffer) => {
          if (output.length < 64 * 1024) output += data.toString();
          onData(data);
        };
        child.stdout?.on("data", capturing);
        child.stderr?.on("data", capturing);

        child.on("error", (err) => {
          if (timeoutHandle) clearTimeout(timeoutHandle);
          reject(err);
        });

        const onAbort = () => {
          if (child.pid) {
            try {
              process.kill(-child.pid, "SIGKILL");
            } catch {
              child.kill("SIGKILL");
            }
          }
        };

        signal?.addEventListener("abort", onAbort, { once: true });

        child.on("close", (code) => {
          if (timeoutHandle) clearTimeout(timeoutHandle);
          signal?.removeEventListener("abort", onAbort);

          if (signal?.aborted) {
            reject(new Error("aborted"));
          } else if (timedOut) {
            reject(new Error(`timeout:${timeout}`));
          } else {
            if (code !== 0) {
              capture.denials = denialLines(output);
              for (const line of capture.denials) {
                logDenial({ cwd, command, line });
              }
            }
            recordTrace(capture, cwd, command);
            if (capture.denials.length > 0 || capture.tracePath) {
              pendingCaptures.push({ command, capture });
              if (pendingCaptures.length > 16) pendingCaptures.shift();
            }
            resolve({ exitCode: code });
          }
        });
      });
    },
  };
}

type TextBlock = { type: "text"; text: string };

/**
 * Mirror the annotation the runtime adds to a violating command on macOS: the
 * model is told, in the tool result itself, which lines looked like the sandbox
 * refusing a path.
 */
function sandboxHint(capture: ExecCapture): string | undefined {
  const parts: string[] = [];
  if (capture.denials.length > 0) {
    parts.push(
      "The command failed on paths the sandbox may not expose:",
      ...capture.denials.map((line) => `  ${line}`),
      "A path outside the sandbox allow list is invisible or read-only inside it;",
      "the allow list is filesystem.allowRead / allowWrite in .pi/sandbox.json.",
    );
  }
  if (capture.tracePath) {
    parts.push(`File-syscall trace appended to ${denialLog()}.`);
  }
  if (parts.length === 0) return undefined;
  return `<sandbox_hint>\n${parts.join("\n")}\n</sandbox_hint>`;
}

/**
 * Session marker other extensions read to know whether bash is really
 * sandboxed. It is published on `globalThis` only once the bash override is
 * wired *and* the sandbox is in force, so a load failure of this file leaves it
 * undefined and a reader can fail closed. Every path that deliberately runs
 * unsandboxed publishes `active: false` with a reason instead.
 */
export type CodassSandboxMarker = {
  active: boolean;
  reason?: string;
  config?: {
    networkRestricted: boolean;
    allowRead: number;
    allowWrite: number;
    denyWrite: number;
    trace: boolean;
  };
};

function publishMarker(marker: CodassSandboxMarker): void {
  (globalThis as { __codassSandbox?: CodassSandboxMarker }).__codassSandbox =
    marker;
}

export default function (pi: ExtensionAPI) {
  pi.registerFlag("no-sandbox", {
    description: "Disable OS-level sandboxing for bash commands",
    type: "boolean",
    default: false,
  });

  const localCwd = process.cwd();
  const localBash = createBashTool(localCwd);

  let sandboxEnabled = false;
  let sandboxInitialized = false;
  let filesystem: FilesystemConfig = {};
  let traceEnabled = false;

  pi.registerTool({
    ...localBash,
    label: "bash (sandboxed)",
    async execute(id, params, signal, onUpdate, _ctx) {
      if (!sandboxEnabled || !sandboxInitialized) {
        return localBash.execute(id, params, signal, onUpdate);
      }

      const sandboxedBash = createBashTool(localCwd, {
        operations: createSandboxedBashOps(traceEnabled, filesystem),
      });
      return sandboxedBash.execute(id, params, signal, onUpdate);
    },
  });

  pi.on("user_bash", () => {
    if (!sandboxEnabled || !sandboxInitialized) return;
    return {
      operations: createSandboxedBashOps(traceEnabled, filesystem),
    };
  });

  pi.on("tool_result", (event) => {
    if (event.toolName !== "bash") return undefined;
    const capture = takeCapture((event.input as { command?: string }).command);
    const hint = capture && sandboxHint(capture);
    if (!hint) return undefined;
    return {
      content: [...event.content, { type: "text", text: hint } as TextBlock],
    };
  });

  pi.on("session_start", async (_event, ctx) => {
    const noSandbox = pi.getFlag("no-sandbox") as boolean;

    if (noSandbox) {
      sandboxEnabled = false;
      publishMarker({ active: false, reason: "--no-sandbox" });
      ctx.ui.notify("Sandbox disabled via --no-sandbox", "warning");
      return;
    }

    const config = loadConfig(ctx.cwd);

    if (!config.enabled) {
      sandboxEnabled = false;
      publishMarker({ active: false, reason: "disabled in sandbox.json" });
      ctx.ui.notify("Sandbox disabled via config", "info");
      return;
    }

    const platform = process.platform;
    if (platform !== "darwin" && platform !== "linux") {
      sandboxEnabled = false;
      publishMarker({
        active: false,
        reason: `unsupported platform ${platform}`,
      });
      ctx.ui.notify(`Sandbox not supported on ${platform}`, "warning");
      return;
    }

    const networkRestricted = config.network?.allowedDomains !== undefined;

    filesystem = config.filesystem ?? {};
    traceEnabled =
      config.trace === true || process.env.PI_SANDBOX_TRACE === "1";
    if (traceEnabled && !hasStrace()) {
      ctx.ui.notify(
        "Sandbox tracing requested but strace is not installed; running untraced",
        "warning",
      );
    }
    // allowRead is this extension's own key; the runtime schema does not know it.
    const { allowRead: _allowRead, ...runtimeFilesystem } = filesystem;

    const publishActive = () =>
      publishMarker({
        active: true,
        config: {
          networkRestricted,
          allowRead: filesystem.allowRead?.length ?? 0,
          allowWrite: filesystem.allowWrite?.length ?? 0,
          denyWrite: filesystem.denyWrite?.length ?? 0,
          trace: traceEnabled,
        },
      });

    try {
      const configExt = config as unknown as {
        ignoreViolations?: Record<string, string[]>;
        enableWeakerNestedSandbox?: boolean;
      };

      await SandboxManager.initialize({
        network: config.network,
        filesystem: runtimeFilesystem,
        ignoreViolations: configExt.ignoreViolations,
        enableWeakerNestedSandbox: configExt.enableWeakerNestedSandbox,
      } as Parameters<typeof SandboxManager.initialize>[0]);

      sandboxEnabled = true;
      sandboxInitialized = true;
      publishActive();

      const networkCount = config.network?.allowedDomains?.length ?? 0;
      const writeCount = config.filesystem?.allowWrite?.length ?? 0;
      ctx.ui.setStatus(
        "sandbox",
        ctx.ui.theme.fg(
          "accent",
          `🔒 Sandbox: ${networkCount} domains, ${writeCount} write paths`,
        ),
      );
      ctx.ui.notify("Sandbox initialized", "info");
    } catch (err) {
      // initialize() stores the config before it checks dependencies, and the
      // only dependency it needs beyond bwrap/rg is socat, used solely by the
      // network bridge. With no domain allowlist that bridge is never built, so
      // filesystem sandboxing is still fully in force.
      if (!networkRestricted) {
        sandboxEnabled = true;
        sandboxInitialized = true;
        publishActive();
        ctx.ui.setStatus(
          "sandbox",
          ctx.ui.theme.fg(
            "accent",
            `🔒 Sandbox: network open, ${config.filesystem?.allowWrite?.length ?? 0} write paths`,
          ),
        );
        ctx.ui.notify(
          `Sandbox initialized without network infrastructure (${err instanceof Error ? err.message : err})`,
          "info",
        );
        return;
      }
      sandboxEnabled = false;
      publishMarker({
        active: false,
        reason: `initialization failed: ${err instanceof Error ? err.message : err}`,
      });
      ctx.ui.notify(
        `Sandbox initialization failed: ${err instanceof Error ? err.message : err}`,
        "error",
      );
    }
  });

  pi.on("session_shutdown", async () => {
    if (sandboxInitialized) {
      try {
        await SandboxManager.reset();
      } catch {
        // Ignore cleanup errors
      }
    }
  });

  pi.registerCommand("sandbox", {
    description: "Show sandbox configuration",
    handler: async (_args, ctx) => {
      if (!sandboxEnabled) {
        ctx.ui.notify("Sandbox is disabled", "info");
        return;
      }

      const config = loadConfig(ctx.cwd);
      const lines = [
        "Sandbox Configuration:",
        "",
        "Network:",
        `  Allowed: ${config.network?.allowedDomains?.join(", ") || "(none)"}`,
        `  Denied: ${config.network?.deniedDomains?.join(", ") || "(none)"}`,
        "",
        "Filesystem:",
        `  Deny Read: ${config.filesystem?.denyRead?.join(", ") || "(none)"}`,
        `  Allow Read: ${config.filesystem?.allowRead?.join(", ") || "(none)"}`,
        `  Allow Write: ${config.filesystem?.allowWrite?.join(", ") || "(none)"}`,
        `  Deny Write: ${config.filesystem?.denyWrite?.join(", ") || "(none)"}`,
        "",
        `Trace: ${traceEnabled ? "on" : "off"}`,
      ];
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}
