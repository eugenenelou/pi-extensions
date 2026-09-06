/**
 * Automatic handoff: the conversation's own auto setting, and the comparison
 * of context usage against its threshold. Free of pi imports, as `lib.ts` is.
 *
 * Three layers, strongest last: the config default, the conversation's
 * `/handoff auto` setting (persisted in the session), and a force held by
 * another extension for as long as its loop or goal runs.
 */

/** The `auto` block of the handoff config file. */
export interface AutoConfig {
  enabled?: boolean;
  /** Token count or percentage of the current model's window. */
  at?: string | number;
}

/** The conversation's own setting, persisted as a custom session entry. */
export interface AutoSetting {
  enabled: boolean;
  at: string | number;
}

/** Custom session entry type carrying `AutoSetting` across resume and handoff. */
export const AUTO_ENTRY_TYPE = "handoff-auto";

export const DEFAULT_AT = "80%";

const VALUE = /^(\d+(?:\.\d+)?)(%|k|M)?$/;

/** A threshold in tokens, or undefined when it is not a count or a percentage. */
export function resolveThreshold(
  at: string | number | undefined,
  contextWindow: number,
): number | undefined {
  if (at === undefined) return undefined;
  if (typeof at === "number") return Number.isFinite(at) ? at : undefined;
  const match = VALUE.exec(at.trim());
  if (!match) return undefined;
  const value = Number(match[1]);
  switch (match[2]) {
    case "%":
      return (value / 100) * contextWindow;
    case "k":
      return value * 1000;
    case "M":
      return value * 1000000;
    default:
      return value;
  }
}

export type AutoCommand =
  | { kind: "on" }
  | { kind: "off" }
  | { kind: "at"; at: string }
  | { kind: "status" }
  | { kind: "invalid"; at: string };

/** `/handoff` arguments as an auto subcommand, or undefined for a focus note. */
export function parseAutoCommand(args: string): AutoCommand | undefined {
  const words = args.trim().split(/\s+/).filter(Boolean);
  if (words[0] !== "auto") return undefined;
  const rest = words.slice(1).join(" ");
  if (rest === "") return { kind: "status" };
  if (rest === "on") return { kind: "on" };
  if (rest === "off") return { kind: "off" };
  if (VALUE.test(rest)) return { kind: "at", at: rest };
  return { kind: "invalid", at: rest };
}

function isSetting(data: unknown): data is AutoSetting {
  if (typeof data !== "object" || data === null) return false;
  const { enabled, at } = data as Record<string, unknown>;
  return (
    typeof enabled === "boolean" &&
    (typeof at === "string" || typeof at === "number")
  );
}

/** The last auto setting recorded in a session's entries, if any. */
export function settingFromEntries(
  entries: readonly { type: string }[],
): AutoSetting | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i] as {
      type: string;
      customType?: string;
      data?: unknown;
    };
    if (entry.type !== "custom" || entry.customType !== AUTO_ENTRY_TYPE)
      continue;
    return isSetting(entry.data) ? entry.data : undefined;
  }
  return undefined;
}

/**
 * A hold placed by another extension for as long as its loop or goal runs.
 *
 * Beyond the threshold it carries what the handoff it triggers must know: the
 * focus note the baton is written under, that a goal is active, and an entry to
 * seed into the successor session so the holder re-arms itself there.
 */
export interface AutoHold {
  /** Token count or percentage; the live threshold when absent. */
  at?: string | number;
  focus?: string;
  goalActive?: boolean;
  seedEntry?: { customType: string; data?: unknown };
  /** Sent to the successor once the baton is in place, to resume the holder's work. */
  seedDirective?: string;
}

export interface Usage {
  tokens: number | null | undefined;
  contextWindow: number;
}

export class AutoHandoff {
  private readonly fallback: AutoSetting;
  private conversation: AutoSetting | undefined;
  private forced: AutoHold | undefined;

  constructor(config: AutoConfig = {}) {
    this.fallback = {
      enabled: config.enabled ?? false,
      at: config.at ?? DEFAULT_AT,
    };
  }

  /** What the conversation is running with right now. */
  private live(): AutoSetting {
    const own = this.conversation ?? this.fallback;
    if (this.forced) return { enabled: true, at: this.forced.at ?? own.at };
    return own;
  }

  /** The conversation's own setting, or undefined while it follows the config. */
  setting(): AutoSetting | undefined {
    return this.conversation;
  }

  /** Applies a subcommand; returns the setting to persist, if it changed. */
  apply(command: AutoCommand): AutoSetting | undefined {
    const current = this.conversation ?? this.fallback;
    switch (command.kind) {
      case "on":
        this.conversation = { enabled: true, at: current.at };
        break;
      case "off":
        this.conversation = { enabled: false, at: current.at };
        break;
      case "at":
        this.conversation = { enabled: true, at: command.at };
        break;
      default:
        return undefined;
    }
    return this.conversation;
  }

  /** Adopt a setting from a resumed session or from the predecessor conversation. */
  restore(setting: AutoSetting): void {
    this.conversation = setting;
  }

  /** Hold auto on for a caller until `release`. */
  force(hold: AutoHold = {}): void {
    this.forced = hold;
  }

  release(): void {
    this.forced = undefined;
  }

  /** The hold in force, which a handoff reads for its focus and its seed entry. */
  hold(): AutoHold | undefined {
    return this.forced;
  }

  indicator(): string | undefined {
    const { enabled, at } = this.live();
    return enabled ? `auto-handoff@${at}` : undefined;
  }

  shouldHandoff(usage: Usage | undefined): boolean {
    const { enabled, at } = this.live();
    if (
      !enabled ||
      !usage ||
      usage.tokens === null ||
      usage.tokens === undefined
    ) {
      return false;
    }
    const threshold = resolveThreshold(at, usage.contextWindow);
    return threshold !== undefined && usage.tokens >= threshold;
  }
}
