/**
 * Probe for the footer's line rewriting, runnable without a TUI:
 *   node --experimental-strip-types footer/render.test.ts
 */

import assert from "node:assert/strict";
import {
  autoHandoffMarker,
  backgroundLine,
  fitToWidth,
  rewriteContextFragment,
  visibleWidth,
} from "./render.ts";

const PLAIN =
  "↑17k ↓114 R50k CH98.9% $0.115 (sub) 6.2%/272k (auto)   gpt-5.6-sol • high";
assert.equal(
  rewriteContextFragment(PLAIN, 17000),
  "↑17k ↓114 R50k CH98.9% $0.115 (sub) 17k/272k 6.2% (auto)   gpt-5.6-sol • high",
);

const ESC = "\u001b";
const COLOURED = `↑17k ↓114 ${ESC}[31m94.2%/272k (auto)${ESC}[0m   gpt-5.6-sol • high`;
assert.equal(
  rewriteContextFragment(COLOURED, 256000),
  `↑17k ↓114 ${ESC}[31m256k/272k 94.2% (auto)${ESC}[0m   gpt-5.6-sol • high`,
);

// An unknown token count (right after compaction) leaves the line alone.
assert.equal(rewriteContextFragment(PLAIN, null), PLAIN);

// A padded stats line stays exactly `width` columns wide after the rewrite.
const WIDTH = 174;

function padded(left: string, right: string): string {
  return left + " ".repeat(WIDTH - visibleWidth(left) - visibleWidth(right)) + right;
}

const PADDED = padded("0.0%/272k (auto)", "gpt-5.6-sol \u2022 high");
assert.equal(visibleWidth(PADDED), WIDTH);
assert.equal(
  visibleWidth(fitToWidth(rewriteContextFragment(PADDED, 16), WIDTH)),
  WIDTH,
);

const PADDED_COLOURED = padded(
  `${ESC}[38;2;102;102;102m94.2%/272k (auto)${ESC}[39m`,
  `${ESC}[38;2;102;102;102mgpt-5.6-sol \u2022 high${ESC}[39m`,
);
assert.equal(visibleWidth(PADDED_COLOURED), WIDTH);
const fittedColoured = fitToWidth(
  rewriteContextFragment(PADDED_COLOURED, 256000),
  WIDTH,
);
assert.equal(visibleWidth(fittedColoured), WIDTH);
assert.match(fittedColoured, /256k\/272k 94\.2%/);

// Padding alone cannot absorb the growth: the line is truncated to `width`.
const TIGHT = "0.0%/272k (auto) gpt-5.6-sol";
assert.equal(visibleWidth(fitToWidth(TIGHT, visibleWidth(TIGHT))), visibleWidth(TIGHT));
const NARROW = 20;
assert.equal(
  visibleWidth(fitToWidth(rewriteContextFragment(TIGHT, 16000), NARROW)),
  NARROW,
);

// Nothing running: no background line at all.
assert.equal(backgroundLine([], 80), undefined);

// Running tasks are listed by id and command.
const TASKS = [
  { id: "bg1", command: "just test backend" },
  { id: "bg2", command: "pnpm build" },
];
assert.equal(
  backgroundLine(TASKS, 80),
  "2 background: bg1 just test backend | bg2 pnpm build",
);
assert.equal(
  backgroundLine(TASKS.slice(0, 1), 80),
  "1 background: bg1 just test backend",
);

// A long list never overflows the terminal.
const NARROW_LINE = backgroundLine(TASKS, 30) as string;
assert.equal(visibleWidth(NARROW_LINE), 30);


// The auto-handoff indicator rides beside the context fragment, and only when on.
const AUTO = rewriteContextFragment(PLAIN, 17000);
assert.equal(autoHandoffMarker(AUTO, undefined), AUTO);
assert.equal(
  autoHandoffMarker(AUTO, "auto-handoff@80%"),
  "↑17k ↓114 R50k CH98.9% $0.115 (sub) 17k/272k 6.2% auto-handoff@80% (auto)   gpt-5.6-sol • high",
);
assert.match(
  autoHandoffMarker(rewriteContextFragment(COLOURED, 256000), "auto-handoff@150k"),
  /94\.2% auto-handoff@150k/,
);

console.log("footer render rewrite: ok");
