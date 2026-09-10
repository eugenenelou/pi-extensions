/** Pure helpers for the loop extension: its env, its clock, its baton note. */

/** Tokens; codass's DEFAULT_HANDOFF_AT. */
const DEFAULT_HANDOFF_AT = 120000;
const DEFAULT_MAX_ITERS = 10;

/** A parsed 5-field cron expression, answering next-fire in local time. */
export interface Schedule {
  expr: string;
  /** The epoch seconds of the first fire strictly after `instant`. */
  nextAfter(instant: number): number;
}

interface Fields {
  minute: Set<number>;
  hour: Set<number>;
  dom: Set<number>;
  month: Set<number>;
  dow: Set<number>;
  domRestricted: boolean;
  dowRestricted: boolean;
}

function parseField(
  spec: string,
  min: number,
  max: number,
): Set<number> | undefined {
  const values = new Set<number>();
  for (const part of spec.split(",")) {
    const [range, stepText] = part.split("/");
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step < 1) return undefined;
    let from: number;
    let to: number;
    if (range === "*") {
      from = min;
      to = max;
    } else if (range.includes("-")) {
      const [a, b] = range.split("-").map(Number);
      if (!Number.isInteger(a) || !Number.isInteger(b)) return undefined;
      from = a;
      to = b;
    } else {
      from = Number(range);
      to = from;
      if (!Number.isInteger(from)) return undefined;
      if (stepText !== undefined) to = max;
    }
    if (from < min || to > max || from > to) return undefined;
    for (let v = from; v <= to; v += step) values.add(v);
  }
  return values.size > 0 ? values : undefined;
}

/** The first minute at or after `civil` may not match; step until one does. */
function matches(civil: Date, fields: Fields): boolean {
  if (!fields.minute.has(civil.getUTCMinutes())) return false;
  if (!fields.hour.has(civil.getUTCHours())) return false;
  if (!fields.month.has(civil.getUTCMonth() + 1)) return false;
  const dom = fields.dom.has(civil.getUTCDate());
  const dow = fields.dow.has(civil.getUTCDay());
  // Standard cron: two restricted day fields are an OR, not an AND.
  if (fields.domRestricted && fields.dowRestricted) return dom || dow;
  if (fields.domRestricted) return dom;
  if (fields.dowRestricted) return dow;
  return true;
}

const MINUTES_SEARCHED = 366 * 24 * 60;

/**
 * Cron windows are wall-clock minutes, so they are enumerated as wall clock and
 * only then read back as instants — the way codass reads cronsim's naive
 * datetimes. A minute a spring forward skips lands just after the gap, and one a
 * fall back repeats resolves to its first pass, instead of being missed or fired
 * twice.
 *
 * The carrier is a UTC date, whose fields are the local ones: it takes calendar
 * steps no DST shift can disturb.
 */
function civilMinuteAfter(instant: number): Date {
  const local = new Date((Math.floor(instant / 60) + 1) * 60000);
  return new Date(
    Date.UTC(
      local.getFullYear(),
      local.getMonth(),
      local.getDate(),
      local.getHours(),
      local.getMinutes(),
    ),
  );
}

function localEpoch(civil: Date): number {
  return (
    new Date(
      civil.getUTCFullYear(),
      civil.getUTCMonth(),
      civil.getUTCDate(),
      civil.getUTCHours(),
      civil.getUTCMinutes(),
    ).getTime() / 1000
  );
}

/** A 5-field cron expression as a schedule, or undefined when malformed. */
export function parseSchedule(expr: string): Schedule | undefined {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return undefined;
  const minute = parseField(parts[0], 0, 59);
  const hour = parseField(parts[1], 0, 23);
  const dom = parseField(parts[2], 1, 31);
  const month = parseField(parts[3], 1, 12);
  const dow = parseField(parts[4], 0, 7);
  if (!minute || !hour || !dom || !month || !dow) return undefined;
  if (dow.delete(7)) dow.add(0);
  const fields: Fields = {
    minute,
    hour,
    dom,
    month,
    dow,
    domRestricted: parts[2] !== "*",
    dowRestricted: parts[4] !== "*",
  };
  return {
    expr,
    nextAfter(instant: number): number {
      const civil = civilMinuteAfter(instant);
      for (let i = 0; i < MINUTES_SEARCHED; i++) {
        if (matches(civil, fields)) {
          const epoch = localEpoch(civil);
          // A wall-clock minute repeated by a fall back maps back before
          // `instant` on its second pass; take the following match instead.
          if (epoch > instant) return epoch;
        }
        civil.setTime(civil.getTime() + 60000);
      }
      throw new Error(`schedule ${expr} never fires`);
    },
  };
}

/**
 * The epoch of the loop's next due tick; null means due now.
 *
 * The same rule the codass sweep applies to the same stamp file: no stamp reads
 * as due at once, an interval loop is due `last_tick + cadence`, a schedule loop
 * at the first cron fire after `last_tick`.
 */
export function nextDueEpoch(
  lastTick: number | null,
  cadenceSeconds: number,
  schedule?: Schedule,
): number | null {
  if (lastTick === null) return null;
  if (schedule) return schedule.nextAfter(lastTick);
  return lastTick + cadenceSeconds;
}

/** The loop contract codass spawns the session with. */
export interface LoopConfig {
  name: string;
  skill: string;
  /** Where the baton is written: codass's `HANDOFF_PATH`. */
  batonPath: string;
  /** Context tokens at which this generation hands over. */
  handoffAt: number;
  /** Ticks after which this generation hands over. */
  maxIters: number;
  cadenceSeconds: number;
  schedule?: Schedule;
}

function intOr(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return value !== undefined && Number.isInteger(parsed) ? parsed : fallback;
}

/** A whole number of seconds, or undefined when the value is not a positive one. */
function positiveSeconds(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

/**
 * The loop config from the spawn env, or undefined when this is not a loop
 * session — the whole extension is inert then.
 *
 * A loop with neither a usable cadence nor a usable schedule has no clock, so it
 * is not a loop session either.
 */
export function parseLoopEnv(
  env: Record<string, string | undefined>,
): LoopConfig | undefined {
  const name = env.CODASS_LOOP;
  const skill = env.LOOP_SKILL;
  const batonPath = env.HANDOFF_PATH;
  if (!name || !skill || !batonPath) return undefined;
  const schedule = env.LOOP_SCHEDULE
    ? parseSchedule(env.LOOP_SCHEDULE)
    : undefined;
  const cadenceSeconds = positiveSeconds(env.LOOP_CADENCE);
  if (!schedule && cadenceSeconds === undefined) return undefined;
  return {
    name,
    skill,
    batonPath,
    handoffAt: intOr(env.HANDOFF_AT, DEFAULT_HANDOFF_AT),
    maxIters: intOr(env.MAX_ITERS, DEFAULT_MAX_ITERS),
    cadenceSeconds: cadenceSeconds ?? 0,
    ...(schedule ? { schedule } : {}),
  };
}

/** What the tick sends: the skill as a slash command, expanded by pi. */
export function tickMessage(config: LoopConfig): string {
  return `/${config.skill}`;
}

/** The focus note the baton is written under at a loop cutover. */
export function loopFocus(config: LoopConfig): string {
  return [
    `This session is the supervised loop "${config.name}", running the /${config.skill}`,
    "tick skill on its own clock. Write the baton for the next generation of the",
    "same loop: what it is watching, what it has already handled and must not",
    "redo, and what the next tick should pick up.",
  ].join(" ");
}

/** The per-generation counter file codass's monitor reads, beside the baton. */
export function iterationCounterPath(
  batonPath: string,
  sessionId: string,
): string {
  const dir = batonPath.slice(0, batonPath.lastIndexOf("/"));
  return `${dir}/.iter-${sessionId || "unknown"}`;
}

/** The stamp codass's monitor reads as the loop's last tick, beside the baton. */
export function lastTickPath(batonPath: string): string {
  return `${batonPath.slice(0, batonPath.lastIndexOf("/"))}/.last-tick`;
}

/** Archives codass's baton consumer keeps; older ones are pruned at each cutover. */
const ARCHIVE_KEEP = 5;

const ARCHIVE = /^handoff-.*\.md$/;

function pad(value: number, width = 2): string {
  return String(value).padStart(width, "0");
}

/** Where a consumed baton is moved, in codass's archive naming (UTC, µs). */
export function batonArchivePath(batonPath: string, now: Date): string {
  const stamp =
    `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}` +
    `T${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}` +
    `_${pad(now.getUTCMilliseconds(), 3)}000Z`;
  return `${batonPath.slice(0, batonPath.lastIndexOf("/"))}/handoff-${stamp}.md`;
}

/** The archive names to drop, keeping the newest `keep` by their stamped order. */
export function staleArchives(
  names: string[],
  keep: number = ARCHIVE_KEEP,
): string[] {
  const archives = names.filter((name) => ARCHIVE.test(name)).sort();
  return archives.slice(0, Math.max(0, archives.length - keep));
}
