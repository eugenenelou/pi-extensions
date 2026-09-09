/**
 * The one filesystem authorization decision shared by bash, background jobs,
 * and Pi's direct file tools.  This module deliberately knows nothing about
 * prompts or command permissions: a folder capability never authorizes a
 * command risk.
 */

import { readlinkSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";

export type FolderAccess = "read" | "read-write";

/** An exact recursive folder capability. */
export type FolderGrant = { root: string; mode: FolderAccess };

export type AccessMode = "read" | "write";
export type PolicyState = "allowed" | "missing" | "protected";

/** The sandbox fields that affect filesystem authorization. */
export type FilesystemPolicyConfig = {
  allowRead?: string[];
  allowWrite?: string[];
  denyRead?: string[];
  denyWrite?: string[];
  /** Restrictions a folder grant must never punch through. */
  protectedRead?: string[];
  protectedWrite?: string[];
  allowGitConfig?: boolean;
};

const HOME = homedir();

// Keep direct tools behind the runtime's mandatory write protections as well
// as configured exclusions. The runtime applies these under the cwd, including
// nested repositories and editor/agent command directories.
const MANDATORY_WRITE_FILES = new Set([
  ".gitconfig",
  ".gitmodules",
  ".bashrc",
  ".bash_profile",
  ".zshrc",
  ".zprofile",
  ".profile",
  ".ripgreprc",
  ".mcp.json",
]);

function isMandatoryWriteProtection(
  path: string,
  allowGitConfig = false,
): boolean {
  const parts = path.split(sep).filter(Boolean);
  if (MANDATORY_WRITE_FILES.has(parts.at(-1) ?? "")) return true;
  for (let index = 0; index < parts.length; index += 1) {
    if (parts[index] === ".vscode" || parts[index] === ".idea") return true;
    if (
      parts[index] === ".claude" &&
      (parts[index + 1] === "commands" || parts[index + 1] === "agents")
    ) return true;
    if (
      parts[index] === ".git" &&
      (parts[index + 1] === "hooks" ||
        (!allowGitConfig && parts[index + 1] === "config"))
    ) return true;
  }
  return false;
}

export function mandatoryWriteProtectionRoots(
  root: string,
  allowGitConfig = false,
): string[] {
  if (isMandatoryWriteProtection(root, allowGitConfig)) return [root];
  if (basename(root) === ".git") {
    return allowGitConfig
      ? [join(root, "hooks")]
      : [join(root, "hooks"), join(root, "config")];
  }
  if (basename(root) === ".claude") {
    return [join(root, "commands"), join(root, "agents")];
  }
  return [
    ...[...MANDATORY_WRITE_FILES].map((file) => join(root, file)),
    join(root, ".vscode"),
    join(root, ".idea"),
    join(root, ".claude", "commands"),
    join(root, ".claude", "agents"),
    join(root, ".git", "hooks"),
    ...(!allowGitConfig ? [join(root, ".git", "config")] : []),
  ];
}

/** Absolute path for config and grant entries, with a leading home expansion. */
export function expandFilesystemPath(pathPattern: string, cwd: string): string {
  if (pathPattern === "~") return HOME;
  if (pathPattern.startsWith("~/")) return join(HOME, pathPattern.slice(2));
  return resolve(cwd, pathPattern);
}

/**
 * Resolve the nearest existing ancestor and retain the missing suffix. This
 * follows symlinks even for a path being created, so an approved link cannot
 * stand in for an unrelated target.
 */
export function resolveFilesystemPath(path: string): string {
  let head = path;
  const tail: string[] = [];
  for (let hop = 0; hop < 40; hop += 1) {
    try {
      return join(realpathSync(head), ...tail);
    } catch {
      try {
        head = resolve(dirname(head), readlinkSync(head));
        continue;
      } catch {
        // It is not a link; preserve this missing component and walk upward.
      }
      const parent = dirname(head);
      if (parent === head) return path;
      tail.unshift(basename(head));
      head = parent;
    }
  }
  throw new Error("filesystem path resolution exceeded the safe symlink depth");
}

export function isWithin(path: string, root: string): boolean {
  // `/` is the one root whose trailing slash is significant.
  if (root === "/") return path.startsWith("/");
  const normalizedRoot = root.endsWith("/") ? root.slice(0, -1) : root;
  return path === normalizedRoot || path.startsWith(`${normalizedRoot}/`);
}

const GLOB_CHARACTERS = /[*?[\]]/;

export function hasFilesystemGlob(pathPattern: string): boolean {
  return GLOB_CHARACTERS.test(pathPattern);
}

/** Normalize glob patterns like the sandbox runtime: realpath only their static base. */
export function normalizeFilesystemPattern(pathPattern: string, cwd: string): string {
  // The runtime defines a trailing `/**` as the directory itself and all of
  // its descendants, and removes the suffix before platform-specific mounts.
  const normalizedPattern = pathPattern.endsWith("/**")
    ? pathPattern.slice(0, -3)
    : pathPattern;
  const expanded = expandFilesystemPath(normalizedPattern, cwd);
  const match = GLOB_CHARACTERS.exec(expanded);
  if (!match) return resolveFilesystemPath(expanded);
  const staticPrefix = expanded.slice(0, match.index);
  const base = staticPrefix.endsWith("/")
    ? staticPrefix.slice(0, -1)
    : dirname(staticPrefix);
  const resolvedBase = resolveFilesystemPath(base || "/");
  return `${resolvedBase}${expanded.slice(base.length)}`;
}

function normalizedEntries(entries: string[] | undefined, cwd: string): string[] {
  return (entries ?? []).map((entry) =>
    normalizeFilesystemPattern(entry, cwd),
  );
}

/** Converts the sandbox runtime's configured glob syntax into a regex source. */
export function filesystemGlobToRegex(entry: string): string {
  return `^${entry
    .replace(/[.^$+{}()|\\]/g, "\\$&")
    .replace(/\[([^\]]*?)$/g, "\\[$1")
    .replace(/\*\*\//g, "__GLOBSTAR_SLASH__")
    .replace(/\*\*/g, "__GLOBSTAR__")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]")
    .replace(/__GLOBSTAR_SLASH__/g, "(.*/)?")
    .replace(/__GLOBSTAR__/g, ".*")}$`;
}

/** Matches configured paths exactly as the platform's OS sandbox does. */
function matchesFilesystemEntry(
  path: string,
  entry: string,
  platform: NodeJS.Platform,
): boolean {
  // bwrap treats glob characters as literals; sandbox-exec accepts them.
  if (!hasFilesystemGlob(entry) || platform !== "darwin") {
    return isWithin(path, entry);
  }
  try {
    return new RegExp(filesystemGlobToRegex(entry)).test(path);
  } catch {
    // An invalid configured exclusion must fail closed rather than grant a
    // direct tool access the OS sandbox would reject.
    return true;
  }
}

/**
 * An immutable effective policy. `withGrants` produces a policy for one
 * execution; it never widens the policy another concurrent execution reads.
 */
export class FilesystemPolicy {
  readonly #config: FilesystemPolicyConfig;
  readonly #cwd: string;
  readonly #grants: FolderGrant[];
  readonly #platform: NodeJS.Platform;

  constructor(
    config: FilesystemPolicyConfig,
    cwd: string,
    grants: FolderGrant[] = [],
    platform: NodeJS.Platform = process.platform,
  ) {
    this.#config = config;
    this.#cwd = cwd;
    this.#grants = grants.map((grant) => ({ ...grant }));
    this.#platform = platform;
  }

  withGrants(grants: FolderGrant[]): FilesystemPolicy {
    return new FilesystemPolicy(this.#config, this.#cwd, [
      ...this.#grants,
      ...grants,
    ], this.#platform);
  }

  /** Canonical grants suitable for the OS sandbox's allow lists. */
  grants(): FolderGrant[] {
    const normalized = new Map<string, FolderAccess>();
    for (const grant of this.#grants) {
      let root: string;
      try {
        root = resolveFilesystemPath(
          expandFilesystemPath(grant.root, this.#cwd),
        );
      } catch {
        // An unresolvable grant cannot safely describe an exact folder root.
        continue;
      }
      if (grant.mode === "read-write" || !normalized.has(root)) {
        normalized.set(root, grant.mode);
      }
    }
    // bwrap applies later mounts last, so a narrower child capability must
    // follow its parent regardless of request order.
    return [...normalized].map(([root, mode]) => ({ root, mode })).sort(
      (left, right) => left.root.length - right.root.length,
    );
  }

  /** A recursive search cannot cross a hidden/protected descendant. */
  evaluateReadTree(rawPath: string): { state: PolicyState; path: string } {
    const decision = this.evaluate("read", rawPath);
    if (decision.state !== "allowed") return decision;
    let root: string;
    try {
      root = resolveFilesystemPath(expandFilesystemPath(rawPath, this.#cwd));
    } catch {
      return { state: "protected", path: expandFilesystemPath(rawPath, this.#cwd) };
    }
    const restrictions = normalizedEntries(
      [...(this.#config.denyRead ?? []), ...(this.#config.protectedRead ?? [])],
      this.#cwd,
    );
    for (const restricted of restrictions) {
      if (hasFilesystemGlob(restricted)) {
        const globAt = restricted.search(/[*?[\]]/);
        const staticPrefix = restricted.slice(0, globAt);
        const staticRoot = staticPrefix.endsWith("/")
          ? staticPrefix.slice(0, -1)
          : dirname(staticPrefix);
        if (isWithin(staticRoot, root)) {
          return { state: "protected", path: restricted };
        }
        continue;
      }
      if (!isWithin(restricted, root)) continue;
      const nested = this.evaluate("read", restricted);
      if (nested.state !== "allowed") return nested;
    }
    return decision;
  }

  evaluate(mode: AccessMode, rawPath: string): { state: PolicyState; path: string } {
    let path: string;
    try {
      path = resolveFilesystemPath(expandFilesystemPath(rawPath, this.#cwd));
    } catch {
      return {
        state: "protected",
        path: expandFilesystemPath(rawPath, this.#cwd),
      };
    }
    if (
      mode === "write" &&
      isMandatoryWriteProtection(path, this.#config.allowGitConfig)
    ) {
      return { state: "protected", path };
    }
    // The OS sandbox hides a protected read root with a tmpfs, so it cannot
    // be written either. A protected write root remains readable when the
    // configured read policy permits it.
    const protectedEntries = normalizedEntries(
      mode === "read"
        ? this.#config.protectedRead
        : [
            ...(this.#config.protectedRead ?? []),
            ...(this.#config.protectedWrite ?? []),
          ],
      this.#cwd,
    );
    if (protectedEntries.some((entry) =>
        matchesFilesystemEntry(path, entry, this.#platform),
      )) {
      return { state: "protected", path };
    }

    const denied = normalizedEntries(
      mode === "read" ? this.#config.denyRead : this.#config.denyWrite,
      this.#cwd,
    );
    const configuredAllow = normalizedEntries(
      mode === "read"
        ? [...(this.#config.allowRead ?? []), ...(this.#config.allowWrite ?? [])]
        : this.#config.allowWrite,
      this.#cwd,
    );
    const grantAllows = this.grants().some(
      (grant) =>
        isWithin(path, grant.root) &&
        (mode === "read" || grant.mode === "read-write"),
    );
    // Linux bwrap overlays denyRead after its configured write bind. Only a
    // subsequent execution grant is mounted late enough to reopen the root.
    const readDenied = normalizedEntries(this.#config.denyRead, this.#cwd);
    const homeHidden = readDenied.some(
      (entry) => entry === resolveFilesystemPath(HOME),
    );
    const homeException =
      homeHidden &&
      configuredAllow.some((entry) =>
        matchesFilesystemEntry(path, entry, this.#platform),
      );
    if (
      mode === "write" &&
      this.#platform === "linux" &&
      readDenied.some((entry) =>
        matchesFilesystemEntry(path, entry, this.#platform),
      ) &&
      !denied.some((entry) =>
        matchesFilesystemEntry(path, entry, this.#platform),
      ) &&
      !grantAllows &&
      !homeException
    ) {
      return { state: "missing", path };
    }

    if (denied.some((entry) =>
        matchesFilesystemEntry(path, entry, this.#platform),
      )) {
      // denyWrite is an explicit exclusion in the existing sandbox config;
      // grants may open default read hiding, never a protected write target.
      if (mode === "write") return { state: "protected", path };
      // `applyAllowRead` only rebinds exceptions after the runtime's home
      // tmpfs. Other denyRead roots stay hidden behind bwrap's later mount.
      return {
        state:
          ((this.#platform === "darwin" || homeHidden) &&
            configuredAllow.some((entry) =>
              matchesFilesystemEntry(path, entry, this.#platform),
            )) || grantAllows
            ? "allowed"
            : "missing",
        path,
      };
    }

    // No write allowlist is the runtime's existing unrestricted-write setting.
    if (mode === "write") {
      if (this.#config.allowWrite === undefined) {
        return { state: "allowed", path };
      }
      return {
        state:
          configuredAllow.some((entry) =>
            matchesFilesystemEntry(path, entry, this.#platform),
          ) || grantAllows
            ? "allowed"
            : "missing",
        path,
      };
    }
    return { state: "allowed", path };
  }
}
