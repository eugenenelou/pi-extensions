/**
 * Probe for the footer's line rewriting, runnable without a TUI:
 *   node --experimental-strip-types footer/render.test.ts
 */

import assert from "node:assert/strict";
import { rewriteContextFragment } from "./render.ts";

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

console.log("footer render rewrite: ok");
