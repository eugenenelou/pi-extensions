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
