/**
 * Probe for the sandbox seam:
 *   node --experimental-strip-types background/sandbox.test.ts
 */

import assert from "node:assert/strict";
import { resolveWrap, type SandboxWrap } from "./sandbox.ts";

const wrap: SandboxWrap = async (command) => `bwrap -- ${command}`;

// No sandbox extension at all, an inactive one, or one publishing no wrap: refuse.
for (const globals of [
  {},
  { __codassSandbox: { active: false, reason: "--no-sandbox" }, __codassSandboxWrap: wrap },
  { __codassSandbox: { active: true } },
]) {
  const resolved = resolveWrap(globals);
  assert.ok("refusal" in resolved, JSON.stringify(globals));
  assert.match(resolved.refusal, /not in force/);
}

assert.match(
  (resolveWrap({ __codassSandbox: { active: false, reason: "--no-sandbox" } }) as { refusal: string }).refusal,
  /--no-sandbox/,
);

const resolved = resolveWrap({
  __codassSandbox: { active: true },
  __codassSandboxWrap: wrap,
});
assert.ok("wrap" in resolved);
assert.equal(await resolved.wrap("make build"), "bwrap -- make build");

console.log("background sandbox seam: ok");
