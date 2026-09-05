/** Line post-processing for the custom footer, free of any pi import. */

/** pi's own `formatTokens` (footer.ts), reproduced: it is not exported. */
export function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
  return `${Math.round(count / 1000000)}M`;
}

/**
 * Rewrite the built-in `<pct>%/<window>` context fragment to
 * `<used>/<window> <pct>%`.
 *
 * Only the visible text is matched, so pi's colour wrapper around a high-usage
 * percentage and the trailing ` (auto)` survive untouched.
 */
export function rewriteContextFragment(
  line: string,
  usedTokens: number | null | undefined,
): string {
  if (usedTokens === null || usedTokens === undefined) return line;
  return line.replace(
    /(\d+(?:\.\d+)?)%\/(\d+(?:\.\d+)?[kM]?)/,
    (_match, percent: string, window: string) =>
      `${formatTokens(usedTokens)}/${window} ${percent}%`,
  );
}

/**
 * ANSI escapes: OSC (hyperlinks, terminated by BEL or ST), CSI (colours) and
 * the two-byte forms. `@earendil-works/pi-tui` does not resolve from this
 * package, so its `visibleWidth`/`truncateToWidth` are reproduced here.
 */
const ANSI =
  /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|\u001b\[[0-9;:?]*[ -/]*[@-~]|\u001b[@-Z\\-_]/g;

/** Visible columns of a line, ANSI escapes excluded. */
export function visibleWidth(line: string): number {
  return [...line.replace(ANSI, "")].length;
}

/** Cut a line to `width` visible columns, escapes preserved and then reset. */
export function truncateToWidth(line: string, width: number): string {
  if (visibleWidth(line) <= width) return line;
  let out = "";
  let used = 0;
  let sawEscape = false;
  for (let i = 0; i < line.length;) {
    ANSI.lastIndex = i;
    const match = ANSI.exec(line);
    if (match && match.index === i) {
      out += match[0];
      sawEscape = true;
      i += match[0].length;
      continue;
    }
    if (used >= width) break;
    const char = String.fromCodePoint(line.codePointAt(i) as number);
    out += char;
    used += 1;
    i += char.length;
  }
  return sawEscape ? `${out}\u001b[0m` : out;
}

/**
 * Bring a line back to `width` visible columns after the rewrite lengthened it.
 *
 * The built-in right-aligns the model name with a run of spaces, so the added
 * characters are taken back out of that run (never below one space);
 * truncation is the backstop, since the TUI kills the process on any line that
 * overflows the terminal.
 */
export function fitToWidth(line: string, width: number): string {
  const excess = visibleWidth(line) - width;
  if (excess <= 0) return line;

  let longest: { index: number; length: number } | undefined;
  for (const run of line.matchAll(/ {2,}/g)) {
    if (!longest || run[0].length > longest.length) {
      longest = { index: run.index as number, length: run[0].length };
    }
  }
  let fitted = line;
  if (longest && longest.length - excess >= 1) {
    fitted =
      line.slice(0, longest.index) +
      " ".repeat(longest.length - excess) +
      line.slice(longest.index + longest.length);
  }
  return truncateToWidth(fitted, width);
}
