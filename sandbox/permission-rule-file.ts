import { randomBytes } from "node:crypto";
import {
  mkdir,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type {
  AllowRule,
  PendingProposal,
} from "./permissions.ts";

type LocalRuleFile = {
  allow?: AllowRule[];
  pending?: PendingProposal[];
  [key: string]: unknown;
};

const LOCK_RETRY_MS = 10;
const LOCK_TIMEOUT_MS = 5_000;

function codeIs(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException).code === code;
}

function token(): string {
  return `${process.pid}-${Date.now()}-${randomBytes(6).toString("hex")}`;
}

type RuleFileLock = {
  release: () => Promise<void>;
};

async function acquireLock(file: string): Promise<RuleFileLock> {
  const lock = `${file}.lock`;
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  await mkdir(dirname(file), { recursive: true });

  while (true) {
    try {
      await mkdir(lock);
      return {
        release: () => rm(lock, { recursive: true, force: true }),
      };
    } catch (error) {
      if (!codeIs(error, "EEXIST")) throw error;
      if (Date.now() >= deadline) {
        throw new Error(
          `timed out waiting for permission file lock: ${file}; ` +
            `if no writer is active, remove ${lock} manually`,
        );
      }
      await new Promise((resolve) =>
        setTimeout(resolve, LOCK_RETRY_MS + Math.floor(Math.random() * 10)),
      );
    }
  }
}

async function canonicalPath(file: string): Promise<string> {
  let current = resolve(file);
  const seen = new Set<string>();
  while (true) {
    if (seen.has(current)) {
      throw new Error(`permission file symlink loop: ${file}`);
    }
    seen.add(current);
    try {
      current = resolve(dirname(current), await readlink(current));
      continue;
    } catch (error) {
      if (codeIs(error, "EINVAL")) return realpath(current);
      if (!codeIs(error, "ENOENT")) throw error;
    }

    const suffix: string[] = [];
    let ancestor = current;
    while (true) {
      suffix.unshift(basename(ancestor));
      ancestor = dirname(ancestor);
      try {
        return join(await realpath(ancestor), ...suffix);
      } catch (error) {
        if (!codeIs(error, "ENOENT")) throw error;
      }
    }
  }
}

async function readRuleFile(file: string): Promise<LocalRuleFile> {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (error) {
    if (codeIs(error, "ENOENT")) return {};
    throw error;
  }
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${file}: not a JSON object`);
  }
  return value as LocalRuleFile;
}

async function mutateRuleFile(
  file: string,
  update: (current: LocalRuleFile) => LocalRuleFile,
): Promise<void> {
  file = await canonicalPath(file);
  const lock = await acquireLock(file);
  const temporary = join(dirname(file), `.${basename(file)}.${token()}.tmp`);
  try {
    const current = await readRuleFile(file);
    const next = update(current);
    if (next === current) return;
    await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
    await lock.release();
  }
}

function sameProposal(one: PendingProposal, other: PendingProposal): boolean {
  return (
    one.rule === other.rule &&
    one.tool === other.tool &&
    one.command === other.command &&
    one.cwd === other.cwd
  );
}

export async function addAllowRule(
  file: string,
  rule: AllowRule,
): Promise<void> {
  await mutateRuleFile(file, (current) => {
    const allow = current.allow ?? [];
    return allow.includes(rule)
      ? current
      : { ...current, allow: [...allow, rule] };
  });
}

export async function addPendingProposal(
  file: string,
  proposal: PendingProposal,
): Promise<void> {
  await mutateRuleFile(file, (current) => {
    const pending = current.pending ?? [];
    return pending.some((known) => sameProposal(known, proposal))
      ? current
      : { ...current, pending: [...pending, proposal] };
  });
}

export async function removePendingProposal(
  file: string,
  proposal: PendingProposal,
): Promise<void> {
  await mutateRuleFile(file, (current) => {
    const pending = current.pending ?? [];
    const kept = pending.filter((entry) => !sameProposal(entry, proposal));
    return kept.length === pending.length
      ? current
      : { ...current, pending: kept };
  });
}
