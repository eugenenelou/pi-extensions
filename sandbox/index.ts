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
 * - <cwd>/.pi/extensions/sandbox.json (project-local)
 *
 * Example .pi/extensions/sandbox.json:
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
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  SandboxManager,
  type SandboxRuntimeConfig,
} from "@anthropic-ai/sandbox-runtime";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  type BashOperations,
  CONFIG_DIR_NAME,
  createBashTool,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";
import {
  type ConfigBases,
  type ConfigScope,
  configErrors,
  configLayers,
  configPath,
  configValues,
  readConfig,
} from "../shared/config.ts";
import { judgeModel } from "../shared/judge.ts";
import { capBashOutput } from "./bash-output.ts";
import {
  FilesystemPolicy,
  expandFilesystemPath,
  filesystemGlobToRegex,
  hasFilesystemGlob,
  isWithin,
  mandatoryWriteProtectionRoots,
  normalizeFilesystemPattern,
  resolveFilesystemPath,
  type FolderGrant,
  type FilesystemPolicyConfig,
} from "./filesystem-policy.ts";
import {
  JUDGE_SYSTEM_PROMPT,
  PermissionMachine,
  type AllowRule,
  type PermissionConfig,
  type PermissionHost,
  type StoredScope,
  type ToolCall,
  type Verdict,
  parseVerdict,
  digestOf,
} from "./permissions.ts";

type FilesystemConfig = Partial<SandboxRuntimeConfig["filesystem"]> &
  FilesystemPolicyConfig & {
    /**
     * Paths kept visible inside a `denyRead` subtree. The runtime has no such
     * key: it is applied here by reordering the bwrap argv (see
     * `applyAllowRead`), so `denyRead: ["~/"]` can hide the whole home directory
     * while a handful of tool directories stay readable.
     */
    allowRead?: string[];
    /** Configured grants are the test/configuration seam; no tool creates them. */
    grants?: FolderGrant[];
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
    // These credential roots are explicit protections, not default hiding:
    // folder grants may not reopen them or descendants.
    protectedRead: ["~/.ssh", "~/.aws", "~/.gnupg"],
    allowWrite: [".", "/tmp"],
    denyWrite: [".env", ".env.*", "*.pem", "*.key"],
  },
};

function configBases(cwd: string): ConfigBases {
  return { agentDir: getAgentDir(), cwd, configDirName: CONFIG_DIR_NAME };
}

function loadConfig(cwd: string): SandboxConfig {
  const layers = configLayers<Partial<SandboxConfig>>(
    "sandbox.json",
    configBases(cwd),
  );
  for (const error of configErrors(layers)) {
    console.error(`Warning: Could not parse ${error}`);
  }
  return configValues(layers).reduce<SandboxConfig>(deepMerge, DEFAULT_CONFIG);
}

/**
 * Merge one filesystem layer over another, adding to the allow lists instead of
 * replacing them.
 *
 * The agent-dir layer is the machine's: which paths under a hidden home hold
 * the toolchain. The project layer is the checkout's: its own root, its store,
 * its env-file denies. Replacing meant whichever layer wrote a key last erased
 * the other's, so a project could silently take away the machine's access to
 * its own tools. Denies still replace — a layer that narrows must be able to.
 */
export function mergeFilesystem(
  base: FilesystemConfig,
  overrides: Partial<FilesystemConfig>,
): FilesystemConfig {
  const merged = { ...base, ...overrides };
  for (const key of ["allowRead", "allowWrite"] as const) {
    const combined = [...(base[key] ?? []), ...(overrides[key] ?? [])];
    if (combined.length > 0) merged[key] = [...new Set(combined)];
  }
  return merged;
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
    result.filesystem = mergeFilesystem(
      base.filesystem ?? {},
      overrides.filesystem,
    );
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

const DEV_NULL_BIND =
  /--(?:ro-)?bind \/dev\/null ((?:"(?:\\.|[^"])*"|'[^']*'|\\.|[^\s])+)(?: )?/g;

/**
 * bwrap creates a missing `--ro-bind` target as a read-only empty file, so every
 * deny path the runtime lists but the project does not have (`.bashrc`, `.env`,
 * `.idea`, …) is materialised as 0-byte litter in the working directory. Dropping
 * the binds whose target does not exist loses nothing: there is no file to hide.
 */
export function dropMissingDevNullBinds(command: string): string {
  if (!command.startsWith("bwrap ")) return command;

  const sep = shellArgumentSeparator(command);
  const argv = sep === -1 ? command : command.slice(0, sep);
  const rest = sep === -1 ? "" : command.slice(sep);

  const filtered = argv.replace(DEV_NULL_BIND, (match, target: string) => {
    const words = shellWords(target);
    const path = words?.length === 1 ? words[0] : target;
    return existsSync(path) ? match : "";
  });

  return filtered + rest;
}

const JAIL = /^(?:exec 9<>\S+ && flock -s 9 && )?(bwrap .*)$/s;

/** The bwrap invocation of a wrapped command, or undefined when it is not jailed. */
export function jailCommand(command: string): string | undefined {
  return JAIL.exec(command)?.[1];
}

/**
 * The files bwrap will create on the host: every `/dev/null` bind whose target
 * is missing gets an empty, read-only mount point in the real directory, and
 * it outlives the jail.
 */
export function placeholderBinds(command: string): string[] {
  const jail = jailCommand(command);
  if (!jail) return [];
  const sep = shellArgumentSeparator(jail);
  const argv = sep === -1 ? jail : jail.slice(0, sep);
  const targets: string[] = [];
  for (const [, target] of argv.matchAll(DEV_NULL_BIND)) {
    const words = shellWords(target);
    const path = words?.length === 1 ? words[0] : target;
    if (!existsSync(path)) targets.push(path);
  }
  return targets;
}

const issuedPlaceholders = new Set<string>();

function jailLock(): string {
  return join(getAgentDir(), "sandbox-jails.lock");
}

/** Removal needs the exclusive lock: no jail that mounted the file is alive. */
function removeCommand(paths: string[]): string {
  const list = paths.map(shellQuote).join(" ");
  return `flock -n 9 && for __pi_f in ${list}; do [ -f "$__pi_f" ] && [ ! -s "$__pi_f" ] && rm -f -- "$__pi_f"; done 2>/dev/null`;
}

/**
 * A jail holds the shared lock from before bwrap creates its placeholders
 * until it exits, on an fd bwrap does not inherit; then it removes what it
 * created. A jail killed before its trailer leaves that to `removePlaceholders`.
 */
function withJailLock(command: string): string {
  if (!command.startsWith("bwrap ")) return command;
  const placeholders = placeholderBinds(command);
  for (const path of placeholders) issuedPlaceholders.add(path);
  const removal =
    placeholders.length > 0 ? `${removeCommand(placeholders)}; ` : "";
  return `exec 9<>${shellQuote(jailLock())} && flock -s 9 && ${command} 9<&-; __pi_rc=$?; ${removal}exit $__pi_rc`;
}

function removePlaceholders(paths: Iterable<string>): void {
  const list = [...paths];
  if (list.length === 0) return;
  spawnSync("bash", [
    "-c",
    `exec 9<>${shellQuote(jailLock())} && ${removeCommand(list)}`,
  ]);
}

const HOME = homedir();

/** Absolute path for a config entry, expanding a leading `~`. */
function expandPath(pathPattern: string, cwd: string = process.cwd()): string {
  return expandFilesystemPath(pathPattern, cwd);
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
 * The files the runtime's launch script executes inside the jail before the
 * user command: the seccomp applier and the filter it loads. Read off the
 * generated command, so wherever the installed runtime resolved them is what
 * gets kept visible.
 */
export function bootstrapAssets(command: string): string[] {
  const sep = shellArgumentSeparator(command);
  if (sep === -1) return [];
  const launch = shellWords(command.slice(sep + " -- ".length));
  const script = launch?.[1] === "-c" ? launch[2] : undefined;
  if (script === undefined) return [];
  for (const line of script.split("\n")) {
    const [applier, filter] = shellWords(line) ?? [];
    if (applier && filter && basename(applier) === "apply-seccomp") {
      return [applier, filter];
    }
  }
  return [];
}

/**
 * Re-expose `filesystem.allowRead` paths inside a home directory hidden by
 * `denyRead`.
 *
 * bwrap applies mounts in argv order, and the runtime emits read denies last —
 * a `--tmpfs ~` would therefore bury the worktree bind that precedes it. The
 * tmpfs is moved to the front of the filesystem mounts, the allowRead paths and
 * the runtime's own launch files are bound read-only right after it, and every
 * write bind and deny the runtime produced keeps its place behind them.
 */
export function applyAllowRead(
  command: string,
  filesystem: FilesystemConfig,
): string {
  if (!command.startsWith("bwrap ")) return command;

  const sep = shellArgumentSeparator(command);
  const argv = sep === -1 ? command : command.slice(0, sep);
  const rest = sep === -1 ? "" : command.slice(sep);

  const homeTmpfs = new RegExp(
    `--tmpfs ${escapeRegExp(shellQuote(HOME))}\\/? `,
    "g",
  );
  if (!homeTmpfs.test(argv)) return command;

  // Parents first: a later parent bind would shadow the child mounted before it.
  const allowRead = [
    ...new Set((filesystem.allowRead ?? []).map((entry) => expandPath(entry))),
  ]
    .filter(existsSync)
    .sort((a, b) => a.length - b.length);
  const bootstrap = bootstrapAssets(command).filter(
    (path) =>
      existsSync(path) && !allowRead.some((root) => isWithin(path, root)),
  );

  const mounts = [
    `--tmpfs ${shellQuote(HOME)} `,
    ...[...allowRead, ...bootstrap].map(
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

/** Locate bwrap's standalone command separator without matching a quoted path. */
function shellArgumentSeparator(command: string): number {
  let quote: "'" | '"' | undefined;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (quote) {
      if (char === quote) quote = undefined;
      else if (char === "\\" && quote === '"') index += 1;
      continue;
    }
    if (char === "'" || char === '"') quote = char;
    else if (char === "\\") index += 1;
    else if (char === " " && command.startsWith(" -- ", index)) return index;
  }
  return -1;
}

/** Decode the shell-quoted bwrap argv well enough to preserve its deny mounts. */
function shellWords(command: string): string[] | undefined {
  const words: string[] = [];
  let word = "";
  let quote: "'" | '"' | undefined;
  let present = false;
  for (let i = 0; i < command.length; i += 1) {
    const char = command[i];
    if (quote) {
      if (char === quote) {
        quote = undefined;
      } else if (char === "\\" && quote === '"') {
        word += command[++i] ?? "";
      } else {
        word += char;
      }
      present = true;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      present = true;
    } else if (char === "\\") {
      word += command[++i] ?? "";
      present = true;
    } else if (/\s/.test(char)) {
      if (present) words.push(word);
      word = "";
      present = false;
    } else {
      word += char;
      present = true;
    }
  }
  if (quote) return undefined;
  if (present) words.push(word);
  return words;
}

const MOUNT_OPTION_ARITY: Record<string, number> = {
  "--bind": 3,
  "--ro-bind": 3,
  "--dev-bind": 3,
  "--tmpfs": 2,
};

/** The first nonexistent component is where a dev-null bind blocks creation. */
const MANDATORY_NAMES = new Set([
  ".gitconfig",
  ".gitmodules",
  ".bashrc",
  ".bash_profile",
  ".zshrc",
  ".zprofile",
  ".profile",
  ".ripgreprc",
  ".mcp.json",
  ".git",
  ".claude",
  ".vscode",
  ".idea",
]);

/** Match the runtime's bounded nested mandatory-protection discovery. */
function mandatoryGrantProtections(
  root: string,
  allowGitConfig: boolean,
): string[] {
  const protectedRoots = new Set(
    mandatoryWriteProtectionRoots(root, allowGitConfig),
  );
  const visit = (directory: string, depth: number) => {
    if (depth >= 3) return;
    try {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (entry.name === "node_modules") continue;
        const path = join(directory, entry.name);
        if (MANDATORY_NAMES.has(entry.name)) {
          for (const protectedPath of mandatoryWriteProtectionRoots(
            path,
            allowGitConfig,
          ))
            protectedRoots.add(protectedPath);
        }
        if (entry.isDirectory()) visit(path, depth + 1);
      }
    } catch {
      return;
    }
  };
  visit(root, 0);
  return [...protectedRoots];
}

function firstMissingComponent(path: string): string {
  let current = path;
  const missing: string[] = [];
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) return path;
    missing.unshift(basename(current));
    current = parent;
  }
  // bwrap may have materialized an earlier missing ancestor as a file. A
  // descendant bind below that file is invalid; replace the file itself.
  if (missing.length > 0 && !statSync(current).isDirectory()) return current;
  return join(current, missing[0] ?? "");
}

/**
 * Re-bind grants after the runtime's read denies. A normal read restriction is
 * default visibility and can be opened narrowly; explicit protected descendants
 * are mounted again afterwards and still win.
 */
/**
 * sandbox-exec profiles are shell-quoted by the runtime. Append exact allow
 * exceptions after its parent deny rules, then repeat explicit protections.
 */
export function applyMacReadGrants(
  command: string,
  grants: FolderGrant[],
  cwd: string,
  protectedRead: string[],
  platform: NodeJS.Platform = process.platform,
  visibleRoots: string[] = [],
  allowGitConfig = false,
): string {
  if (platform !== "darwin") return command;
  const readable = new FilesystemPolicy({}, cwd, grants).grants();
  const visible = new FilesystemPolicy(
    {},
    cwd,
    visibleRoots.map((root) => ({ root, mode: "read" as const })),
  ).grants();
  if (readable.length === 0 && visible.length === 0) return command;
  const profileMatch = /sandbox-exec -p ('(?:[^']|'\\''?)*') /.exec(command);
  if (!profileMatch) return command;
  const quoted = profileMatch[1];
  const profile = quoted.slice(1, -1).replace(/'\\''/g, "'");
  const protectedRules = [
    ...new Set(
      protectedRead.map((entry) => {
        const path = normalizeFilesystemPattern(entry, cwd);
        return hasFilesystemGlob(path)
          ? `(deny file-read* (regex ${JSON.stringify(filesystemGlobToRegex(path))}))`
          : `(deny file-read* (subpath ${JSON.stringify(path)}))`;
      }),
    ),
  ];
  const mandatoryWriteRules = readable.flatMap((grant) =>
    mandatoryGrantProtections(grant.root, allowGitConfig).map(
      (path) => `(deny file-write* (subpath ${JSON.stringify(path)}))`,
    ),
  );
  const exceptions = [
    ...[...readable, ...visible].map(
      (grant) => `(allow file-read* (subpath ${JSON.stringify(grant.root)}))`,
    ),
    ...protectedRules,
    ...mandatoryWriteRules,
  ].join("\n");
  return command.replace(quoted, shellQuote(`${profile}\n${exceptions}`));
}

export function applyExecutionGrants(
  command: string,
  grants: FolderGrant[],
  cwd: string,
  protectedRead: string[],
  protectedWrite: string[],
  normalReadAllowRoots: string[] = [],
  allowGitConfig = false,
  configuredWriteRoots: string[] = [],
): string {
  if (!command.startsWith("bwrap ")) return command;
  const normalizedGrants = new FilesystemPolicy({}, cwd, grants).grants();
  const sep = shellArgumentSeparator(command);
  if (sep === -1) return command;
  const argv = command.slice(0, sep);
  const paths = (entries: string[]) =>
    [
      ...new Set(
        entries.map((entry) =>
          resolveFilesystemPath(expandFilesystemPath(entry, cwd)),
        ),
      ),
    ].sort((a, b) => a.length - b.length);
  const readProtected = paths(protectedRead);
  const explicitWriteProtected = paths(protectedWrite);
  // A parent write exclusion cannot be remounted after a child grant: that
  // would reopen the parent for reads. Downgrade that grant to read-only; it
  // remains an exact visibility exception without bypassing the exclusion.
  const effectiveGrants = normalizedGrants.map((grant) =>
    grant.mode === "read-write" &&
    (explicitWriteProtected.some((path) => isWithin(grant.root, path)) ||
      mandatoryGrantProtections(grant.root, allowGitConfig).includes(
        grant.root,
      ))
      ? { ...grant, mode: "read" as const }
      : grant,
  );
  const configuredWrites = new FilesystemPolicy(
    {},
    cwd,
    configuredWriteRoots.map((root) => ({ root, mode: "read-write" as const })),
  ).grants();
  const writeProtected = paths([
    ...explicitWriteProtected,
    // The runtime always protects the command cwd, even when a broader grant
    // is mounted after its generated denial binds.
    ...mandatoryGrantProtections(cwd, allowGitConfig),
    // Outside the cwd only existing files are protected: blocking creation
    // there costs a bwrap mount per name per root, and bwrap materializes each
    // missing target as an empty file on the host.
    ...[...effectiveGrants, ...configuredWrites].flatMap((grant) =>
      mandatoryGrantProtections(grant.root, allowGitConfig).filter(
        (path) => isWithin(path, cwd) || existsSync(path),
      ),
    ),
  ]);
  const writeProtectionsToMount = writeProtected.filter(
    (path) => !effectiveGrants.some((grant) => isWithin(grant.root, path)),
  );
  // These are the only source=target read-only binds this extension adds for
  // default visibility. A read/write grant may intentionally replace one, and
  // a later deny may hide the runtime's launch files (the start-up check then
  // refuses); every other source=target bind came from the runtime as a
  // protection.
  const normalReadAllows = new Set([
    ...paths(normalReadAllowRoots),
    ...bootstrapAssets(command),
  ]);
  // The runtime places mandatory and configured write denies after its allow
  // binds. A late read/write bind must preserve those exact mounts instead of
  // accidentally reopening hooks, settings, or a denyWrite descendant.
  const words = shellWords(argv);
  if (!words) return command;
  const argvMounts = new Set<string>();
  for (let index = 0; index < words.length - 1; index += 1) {
    const arity = MOUNT_OPTION_ARITY[words[index]];
    if (arity) argvMounts.add(words.slice(index, index + arity).join("\0"));
  }
  // Without a grant bind nothing appended can reopen a runtime mount, so a
  // mount the runtime already made is a pure duplicate.
  const reassert = normalizedGrants.length > 0;
  const alreadyMounted = (mount: string): boolean =>
    !reassert && argvMounts.has(shellWords(mount)?.join("\0") ?? "");
  const preservedDenyBinds: string[] = [];
  for (let index = 0; index < words.length - 2; index += 1) {
    if (words[index] !== "--ro-bind") continue;
    const source = words[index + 1];
    const target = words[index + 2];
    if (
      source === "/dev/null" ||
      (source === target && source !== "/" && !normalReadAllows.has(source))
    ) {
      preservedDenyBinds.push(
        `--ro-bind ${shellQuote(source)} ${shellQuote(target)}`,
      );
    }
  }
  // A missing path is blocked from creation with a dev-null mount only where
  // something in the jail could create it. Under a read-only parent bwrap
  // cannot even create the mount point, and nothing needs blocking there.
  const writableRoots = [
    ...effectiveGrants.filter((grant) => grant.mode === "read-write"),
    ...configuredWrites,
  ].map((grant) => grant.root);
  const creationBlock = (path: string): string | undefined => {
    const component = firstMissingComponent(path);
    if (!writableRoots.some((root) => isWithin(dirname(component), root)))
      return undefined;
    // A file ancestor (e.g. a worktree's `.git` pointer) is frozen onto itself:
    // a mount point can't be deleted or recreated as a directory, and reads
    // of the real content still work, unlike a /dev/null mask.
    return existsSync(component)
      ? `--ro-bind ${shellQuote(component)} ${shellQuote(component)}`
      : `--ro-bind /dev/null ${shellQuote(component)}`;
  };
  const mounts = [
    ...effectiveGrants.map(
      (grant) =>
        `${grant.mode === "read-write" ? "--bind" : "--ro-bind"} ${shellQuote(grant.root)} ${shellQuote(grant.root)}`,
    ),
    ...preservedDenyBinds,
    // A read-only bind preserves ordinary reads while preventing a parent
    // read/write grant from reopening an explicit write exclusion.
    ...writeProtectionsToMount.map((path) =>
      existsSync(path)
        ? `--ro-bind ${shellQuote(path)} ${shellQuote(path)}`
        : creationBlock(path),
    ),
    // Read protections must remain last: a preceding write exclusion exposes
    // host contents, whereas tmpfs/dev-null hides them completely. A missing
    // protected descendant gets the same creation-blocking dev-null mount.
    ...readProtected.map((path) =>
      !existsSync(path)
        ? creationBlock(path)
        : statSync(path).isDirectory()
          ? `--tmpfs ${shellQuote(path)}`
          : `--ro-bind /dev/null ${shellQuote(path)}`,
    ),
  ]
    .filter((mount) => mount !== undefined && !alreadyMounted(mount))
    .filter((mount, index, all) => all.indexOf(mount) === index)
    .join(" ");
  if (!mounts) return command;

  return `${argv} ${mounts}${command.slice(sep)}`;
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

/**
 * Merge configured and execution-specific grants into the runtime input. The
 * result is constructed for one process launch and never widens the session's
 * shared configuration.
 */
function effectiveFilesystem(
  filesystem: FilesystemConfig,
  cwd: string,
  executionGrants: FolderGrant[] = [],
): FilesystemConfig {
  const grants = new FilesystemPolicy(filesystem, cwd, [
    ...(filesystem.grants ?? []),
    ...executionGrants,
  ]).grants();
  const readRoots = grants.map((grant) => grant.root);
  const writeRoots = grants
    .filter((grant) => grant.mode === "read-write")
    .map((grant) => grant.root);
  return {
    ...filesystem,
    allowRead: [...new Set([...(filesystem.allowRead ?? []), ...readRoots])],
    allowWrite: [...new Set([...(filesystem.allowWrite ?? []), ...writeRoots])],
    // Explicit exclusions remain runtime denies beneath an approved root.
    denyRead: [
      ...new Set([
        ...(filesystem.denyRead ?? []),
        ...(filesystem.protectedRead ?? []),
      ]),
    ],
    denyWrite: [
      ...new Set([
        ...(filesystem.denyWrite ?? []),
        ...(filesystem.protectedRead ?? []),
        ...(filesystem.protectedWrite ?? []),
      ]),
    ],
  };
}

/** The confinement a command gets before it is handed to `bash -c`. */
export async function wrapForSandbox(
  command: string,
  filesystem: FilesystemConfig,
  cwd: string = process.cwd(),
  executionGrants: FolderGrant[] = [],
): Promise<string> {
  const effective = effectiveFilesystem(filesystem, cwd, executionGrants);
  const {
    allowRead: _allowRead,
    grants: _grants,
    protectedRead: _protectedRead,
    protectedWrite: _protectedWrite,
    ...runtimeFilesystem
  } = effective;
  // Supplying the complete per-execution runtime policy is essential on macOS
  // (where there is no bwrap argv to rewrite) and keeps mandatory runtime
  // deny rules ordered after read/write grants on both platforms.
  const wrapped = dropMissingDevNullBinds(
    await SandboxManager.wrapWithSandbox(command, undefined, {
      filesystem: runtimeFilesystem,
    } as Parameters<typeof SandboxManager.wrapWithSandbox>[2]),
  );
  const grants = [...(filesystem.grants ?? []), ...executionGrants];
  return withJailLock(
    applyMacReadGrants(
      applyExecutionGrants(
        applyAllowRead(wrapped, effective),
        grants,
        cwd,
        effective.protectedRead ?? [],
        [...(effective.denyWrite ?? []), ...(effective.protectedWrite ?? [])],
        effective.allowRead ?? [],
        filesystem.allowGitConfig === true,
        effective.allowWrite ?? [],
      ),
      grants,
      cwd,
      effective.protectedRead ?? [],
      process.platform,
      [...(effective.allowRead ?? []), ...(effective.allowWrite ?? [])],
      filesystem.allowGitConfig === true,
    ),
  );
}

export type BootstrapCheck = { ok: true } | { ok: false; reason: string };

/**
 * Run one harmless command through the jail exactly as bash will. A jail that
 * cannot start — its launch files hidden by a deny or missing from the
 * machine — is refused at session start with the cause, instead of failing
 * every command later with bash's bare "No such file or directory".
 */
export async function verifySandboxBootstrap(
  filesystem: FilesystemConfig,
  cwd: string = process.cwd(),
): Promise<BootstrapCheck> {
  const wrapped = await wrapForSandbox("true", filesystem, cwd);
  if (!jailCommand(wrapped)) return { ok: true };
  const result = await new Promise<{ status: number | null; stderr: string }>(
    (resolve) => {
      const child = spawn("bash", ["-c", wrapped], {
        cwd,
        stdio: ["ignore", "ignore", "pipe"],
      });
      let stderr = "";
      child.stderr?.on("data", (chunk) => (stderr += chunk));
      const timer = setTimeout(() => child.kill("SIGKILL"), 15_000);
      child.on("error", (error) => {
        clearTimeout(timer);
        resolve({ status: null, stderr: String(error) });
      });
      child.on("close", (status) => {
        clearTimeout(timer);
        resolve({ status, stderr });
      });
    },
  );
  if (result.status === 0) return { ok: true };

  const denies = [
    ...(filesystem.denyRead ?? []),
    ...(filesystem.protectedRead ?? []),
  ];
  const causes = bootstrapAssets(wrapped).flatMap((asset) => {
    if (!existsSync(asset)) return [`${asset} is missing on this machine`];
    // The home tmpfs is the one deny the launch files are re-bound behind.
    const hiding = denies.filter((entry) => {
      const path = expandPath(entry, cwd).replace(/\/+$/, "");
      return path !== HOME && isWithin(asset, path);
    });
    return hiding.length > 0
      ? [`${asset} is hidden by denyRead ${hiding.join(", ")}`]
      : [];
  });
  const detail =
    causes.length > 0
      ? causes.join("; ")
      : (result.stderr ?? "").trim() || `exit status ${result.status}`;
  return { ok: false, reason: `the sandbox cannot start a command: ${detail}` };
}

function createSandboxedBashOps(
  trace: boolean,
  filesystem: FilesystemConfig,
  executionGrants: FolderGrant[] = [],
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

      const wrappedCommand = await wrapForSandbox(
        inner,
        filesystem,
        cwd,
        executionGrants,
      );

      const placeholders = placeholderBinds(wrappedCommand);

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
          if (signal?.aborted || timedOut) removePlaceholders(placeholders);

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
      "the allow list is filesystem.allowRead / allowWrite in .pi/extensions/sandbox.json.",
    );
  }
  if (capture.tracePath) {
    parts.push(`File-syscall trace appended to ${denialLog()}.`);
  }
  if (parts.length === 0) return undefined;
  return `<sandbox_hint>\n${parts.join("\n")}\n</sandbox_hint>`;
}

const SANDBOX_BLOCK =
  "sandbox is not active; refusing bash (set PI_SANDBOX_OFF=1 to run unsandboxed on purpose)";

type GuardCtx = Pick<ExtensionContext, "cwd" | "hasUI" | "ui">;

let sandboxAnnounced = false;

function announceOnce(
  ctx: GuardCtx,
  message: string,
  level: "info" | "warning" | "error",
): void {
  if (sandboxAnnounced) return;
  sandboxAnnounced = true;
  if (ctx.hasUI) ctx.ui.notify(message, level);
  else console.error(message);
}

function envPathReason(path: unknown): string | undefined {
  if (typeof path !== "string") return undefined;
  const name = basename(path);
  return name.startsWith(".env") ? `write to ${name}` : undefined;
}

/**
 * Real path of the nearest existing ancestor plus the missing tail, following
 * dangling links, so a symlink at any component cannot redirect out of the roots.
 */
/** The shared policy applied at Pi's direct file/search-tool boundary. */
export function sandboxPathReason(
  tool: string,
  rawPath: unknown,
  cwd: string,
  filesystem: FilesystemConfig,
  executionGrants: FolderGrant[] = [],
): string | undefined {
  if (typeof rawPath !== "string" || !rawPath) return undefined;
  const policy = new FilesystemPolicy(filesystem, cwd, [
    ...(filesystem.grants ?? []),
    ...executionGrants,
  ]);
  const mode = tool === "write" || tool === "edit" ? "write" : "read";
  const decision =
    mode === "read" && ["grep", "find", "ls"].includes(tool)
      ? policy.evaluateReadTree(rawPath)
      : policy.evaluate(mode, rawPath);
  if (decision.state === "allowed") return undefined;
  if (decision.state === "protected") {
    return `${mode} of ${decision.path}: protected by the sandbox policy`;
  }
  return mode === "write"
    ? `write to ${decision.path}: outside the sandbox allowWrite list`
    : `read of ${decision.path}: hidden by the sandbox denyRead list`;
}

/**
 * The rendered permission lists, and the rules the dialog remembered.
 *
 * codass writes the fixed lists at deploy: `extensions/permissions.json` under
 * the agent dir for a profile, under `.pi/` for a project, and the two are
 * unioned. A grant made from the dialog is written beside them, in
 * `permissions.local.json`, so a redeploy never overwrites it.
 *
 * An unparseable file makes the machine fail closed, so it is reported rather
 * than skipped like an absent one.
 */
function ruleFileConfig(file: string): PermissionConfig {
  const doc = readConfig<PermissionConfig>(file);
  return doc.state === "present" ? doc.value : {};
}

function loadPermissionConfig(cwd: string): PermissionConfig {
  const bases = configBases(cwd);
  const layers = configLayers<PermissionConfig>("permissions.json", bases);
  const configs = configValues(layers);
  const errors = [
    ...configErrors(layers),
    ...configErrors(
      configLayers<PermissionConfig>("permissions.local.json", bases),
    ),
  ];
  return {
    deny: configs.flatMap((config) => config.deny ?? []),
    allow: [...new Set(configs.flatMap((config) => config.allow ?? []))],
    unreadable: errors.length ? errors.join("; ") : undefined,
  };
}

function localRulesPath(scope: StoredScope, cwd: string): string {
  const layer: ConfigScope = scope === "global" ? "global" : "project";
  return configPath("permissions.local.json", layer, configBases(cwd));
}

let announcedUnreadable: string | undefined;

/** Failing closed is invisible otherwise: say once why every call now asks. */
function announceUnreadable(ctx: GuardCtx, message: string): void {
  if (announcedUnreadable === message) return;
  announcedUnreadable = message;
  const text = `permission rules unreadable, failing closed: ${message}`;
  if (ctx.hasUI) ctx.ui.notify(text, "error");
  else console.error(text);
}

/** The tool call as the model wrote it, for the judge to read. */
function judgeInput(call: ToolCall, cwd: string): string {
  const subject =
    call.toolName === "bash"
      ? `command: ${call.command}`
      : typeof call.path === "string"
        ? `path: ${call.path}`
        : `arguments: ${digestOf(call)}`;
  return `working directory: ${cwd}\ntool: ${call.toolName}\n${subject}`;
}

async function askJudge(
  ctx: ExtensionContext,
  call: ToolCall,
  signal: AbortSignal,
): Promise<Verdict> {
  const { model, thinking } = judgeModel(ctx, configBases(ctx.cwd));
  if (!model) return { verdict: "ask", reason: "no judge model configured" };
  try {
    const response = await ctx.modelRegistry.complete(
      model,
      {
        systemPrompt: JUDGE_SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: judgeInput(call, ctx.cwd) }],
            timestamp: Date.now(),
          },
        ],
      },
      { cacheRetention: "none", reasoning: thinking, signal },
    );
    const text = response.content
      .filter((block): block is TextBlock => block.type === "text")
      .map((block) => block.text)
      .join("\n");
    return parseVerdict(text);
  } catch (err) {
    return {
      verdict: "ask",
      reason: `judge unavailable (${err instanceof Error ? err.message : err})`,
    };
  }
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

/**
 * Published beside an active marker, so an extension running a command outside
 * the bash tool confines it identically instead of rebuilding the jail. It is
 * the very function `exec` runs its own commands through; it is cleared
 * whenever the marker turns inactive.
 */
export type CodassSandboxWrap = (
  command: string,
  executionId?: string,
) => Promise<string>;

/** Injected only by the access-request flow added in a later ticket. */
export type CodassSandboxGrantForExecution = (
  executionId: string,
  grants: FolderGrant[],
) => void;

function publishMarker(
  marker: CodassSandboxMarker,
  wrap?: CodassSandboxWrap,
  grantForExecution?: CodassSandboxGrantForExecution,
): void {
  const globals = globalThis as {
    __codassSandbox?: CodassSandboxMarker;
    __codassSandboxWrap?: CodassSandboxWrap;
    __codassSandboxGrantForExecution?: CodassSandboxGrantForExecution;
  };
  globals.__codassSandboxWrap = wrap;
  globals.__codassSandboxGrantForExecution = grantForExecution;
  globals.__codassSandbox = marker;
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
  // The start-up probe runs while the session comes up; bash and path checks
  // wait for its verdict instead of seeing a half-initialized sandbox.
  let bootstrapPending: Promise<void> | undefined;
  /**
   * The context of the call being decided. The machine outlives any single
   * call — its conversation-scoped grants do — so the host reads the live one
   * instead of capturing it.
   */
  let deciding: ExtensionContext | undefined;
  const permissionHost: PermissionHost = {
    hasUI: () => deciding?.hasUI ?? false,
    readRules: (scope) => {
      const cwd = deciding?.cwd ?? localCwd;
      return ruleFileConfig(localRulesPath(scope, cwd)).allow ?? [];
    },
    writeRules: (scope, rules: AllowRule[]) => {
      const path = localRulesPath(scope, deciding?.cwd ?? localCwd);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, `${JSON.stringify({ allow: rules }, null, 2)}\n`);
    },
    judge: (call, signal) =>
      deciding
        ? askJudge(deciding, call, signal)
        : Promise.resolve({ verdict: "ask", reason: "no session context" }),
    select: async (message, choices) =>
      deciding?.hasUI ? deciding.ui.select(message, choices) : undefined,
  };
  const permissions = new PermissionMachine({}, permissionHost);
  let filesystem: FilesystemConfig = {};
  let traceEnabled = false;
  // A grant is consumed by the execution id it was issued for. Keeping this
  // map outside the base policy prevents sibling calls from inheriting it.
  const executionGrants = new Map<string, FolderGrant[]>();
  const grantForExecution: CodassSandboxGrantForExecution = (id, grants) => {
    executionGrants.set(
      id,
      grants.map((grant) => ({ ...grant })),
    );
  };
  const grantsForExecution = (id: string): FolderGrant[] =>
    executionGrants.get(id) ?? [];
  const takeGrantsForExecution = (id: string): FolderGrant[] => {
    const grants = grantsForExecution(id);
    executionGrants.delete(id);
    return grants;
  };

  pi.registerTool({
    ...localBash,
    label: "bash (sandboxed)",
    async execute(id, params, signal, onUpdate, _ctx) {
      await bootstrapPending;
      if (!sandboxEnabled || !sandboxInitialized) {
        return localBash.execute(id, params, signal, onUpdate);
      }

      const sandboxedBash = createBashTool(localCwd, {
        operations: createSandboxedBashOps(
          traceEnabled,
          filesystem,
          grantsForExecution(id),
        ),
      });
      return sandboxedBash.execute(id, params, signal, onUpdate);
    },
  });

  pi.on("user_bash", async () => {
    await bootstrapPending;
    if (!sandboxEnabled || !sandboxInitialized) return;
    return {
      operations: createSandboxedBashOps(traceEnabled, filesystem),
    };
  });

  /**
   * Bash is refused unless the sandbox is really in force: a session where
   * initialization never ran would otherwise fall back to pi's unsandboxed
   * bash. Checked at call time, never at load — `session_start` decides it.
   */
  const sandboxGate = (ctx: GuardCtx): string | undefined => {
    if (process.env.PI_SANDBOX_OFF === "1") {
      announceOnce(ctx, "PI_SANDBOX_OFF=1 — bash runs UNSANDBOXED", "warning");
      return undefined;
    }
    if (sandboxEnabled && sandboxInitialized) return undefined;
    announceOnce(ctx, SANDBOX_BLOCK, "error");
    return SANDBOX_BLOCK;
  };

  /**
   * Deny list, then allow list, then the judge — skipped entirely when codass
   * has deployed no lists, so an unconfigured setup keeps pi's own behaviour.
   */
  const decide = async (
    toolName: string,
    input: { command?: string; path?: unknown },
    ctx: ExtensionContext,
  ) => {
    const config = loadPermissionConfig(ctx.cwd);
    if (!config.unreadable && !config.deny?.length && !config.allow?.length) {
      return undefined;
    }
    if (config.unreadable) announceUnreadable(ctx, config.unreadable);
    permissions.setConfig(config);
    deciding = ctx;
    const decision = await permissions.decide({
      toolName,
      command: input.command,
      path: typeof input.path === "string" ? input.path : undefined,
      input,
    });
    if (decision) {
      logDenial({
        cwd: ctx.cwd,
        tool: toolName,
        command: input.command,
        path: input.path,
        reason: decision.reason,
      });
    }
    return decision;
  };

  pi.on("tool_call", async (event, ctx) => {
    await bootstrapPending;
    const input = event.input as { command?: string; path?: unknown };
    let reason: string | undefined;
    let pathReason: string | undefined;

    if (event.toolName === "bash") {
      if (typeof input.command !== "string") return undefined;
      const gateReason = sandboxGate(ctx);
      if (gateReason) {
        logDenial({
          cwd: ctx.cwd,
          tool: "bash",
          command: input.command,
          reason: gateReason,
        });
        return { block: true, reason: gateReason };
      }
    } else {
      // Only writes to an env file are guarded; reading one is allowed.
      if (event.toolName === "write" || event.toolName === "edit") {
        reason = envPathReason(input.path);
      }
      if (!reason && sandboxEnabled && sandboxInitialized) {
        // Search/list tools use the cwd when their optional path is omitted;
        // enforce that implicit filesystem access just as we do an explicit one.
        const path =
          typeof input.path === "string"
            ? input.path
            : ["grep", "find", "ls"].includes(event.toolName)
              ? "."
              : undefined;
        pathReason = sandboxPathReason(
          event.toolName,
          path,
          ctx.cwd,
          filesystem,
          grantsForExecution(event.toolCallId),
        );
        reason = pathReason;
      }
    }

    if (!reason) return decide(event.toolName, input, ctx);
    const message = `sandbox guard: ${reason}`;
    // A command approval must not turn into a filesystem capability. A later
    // folder-access flow supplies an execution-bound policy grant instead.
    if (pathReason) {
      logDenial({
        cwd: ctx.cwd,
        tool: event.toolName,
        path: input.path,
        reason: pathReason,
      });
      return { block: true, reason: message };
    }
    const blocked =
      !ctx.hasUI ||
      (await ctx.ui.select(message, ["Block", "Allow once"])) !== "Allow once";
    return blocked ? { block: true, reason: message } : undefined;
  });

  pi.on("tool_execution_end", (event) => {
    executionGrants.delete(event.toolCallId);
  });

  pi.on("tool_result", (event) => {
    if (event.toolName !== "bash") return undefined;
    const capture = takeCapture((event.input as { command?: string }).command);
    const hint = capture && sandboxHint(capture);
    const details = event.details as
      | { truncation?: { totalLines?: number }; fullOutputPath?: string }
      | undefined;
    let capped = false;
    const content = event.content.map((block) => {
      if (block.type !== "text") return block;
      const text = capBashOutput(block.text, {
        fullOutputPath: details?.fullOutputPath,
        totalLines: details?.truncation?.totalLines,
      });
      if (text === undefined) return block;
      capped = true;
      return { ...block, text } as TextBlock;
    });
    if (!hint && !capped) return undefined;
    return {
      content: hint
        ? [...content, { type: "text", text: hint } as TextBlock]
        : content,
    };
  });

  pi.on("session_start", async (_event, ctx) => {
    permissions.reset();
    executionGrants.clear();
    filesystem = {};
    traceEnabled = false;
    sandboxEnabled = false;
    sandboxInitialized = false;
    bootstrapPending = undefined;
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
    // These extension-only keys are applied while each execution is built.
    const initializedFilesystem = effectiveFilesystem(filesystem, ctx.cwd);
    const {
      allowRead: _allowRead,
      grants: _grants,
      protectedRead: _protectedRead,
      protectedWrite: _protectedWrite,
      ...runtimeFilesystem
    } = initializedFilesystem;

    const refuse = (reason: string) => {
      sandboxEnabled = false;
      publishMarker({ active: false, reason });
      ctx.ui.notify(`Sandbox refused: ${reason}`, "error");
    };
    const startBootstrap = (statusText: string, notice: string) => {
      const pending = verifySandboxBootstrap(filesystem, ctx.cwd).then(
        (bootstrap) => {
          if (bootstrapPending === pending) bootstrapPending = undefined;
          if (!bootstrap.ok) return refuse(bootstrap.reason);
          sandboxEnabled = true;
          sandboxInitialized = true;
          publishActive();
          ctx.ui.setStatus("sandbox", ctx.ui.theme.fg("accent", statusText));
          ctx.ui.notify(notice, "info");
        },
      );
      bootstrapPending = pending;
    };
    const publishActive = () =>
      publishMarker(
        {
          active: true,
          config: {
            networkRestricted,
            allowRead: filesystem.allowRead?.length ?? 0,
            allowWrite: filesystem.allowWrite?.length ?? 0,
            denyWrite: filesystem.denyWrite?.length ?? 0,
            trace: traceEnabled,
          },
        },
        (command, executionId) =>
          wrapForSandbox(
            command,
            filesystem,
            ctx.cwd,
            executionId ? takeGrantsForExecution(executionId) : [],
          ),
        grantForExecution,
      );

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

      const networkCount = config.network?.allowedDomains?.length ?? 0;
      const writeCount = config.filesystem?.allowWrite?.length ?? 0;
      startBootstrap(
        `🔒 Sandbox: ${networkCount} domains, ${writeCount} write paths`,
        "Sandbox initialized",
      );
    } catch (err) {
      // initialize() stores the config before it checks dependencies, and the
      // only dependency it needs beyond bwrap/rg is socat, used solely by the
      // network bridge. With no domain allowlist that bridge is never built, so
      // filesystem sandboxing is still fully in force.
      if (!networkRestricted) {
        startBootstrap(
          `🔒 Sandbox: network open, ${config.filesystem?.allowWrite?.length ?? 0} write paths`,
          `Sandbox initialized without network infrastructure (${err instanceof Error ? err.message : err})`,
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
    removePlaceholders(issuedPlaceholders);
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
