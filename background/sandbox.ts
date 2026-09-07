/**
 * The seam onto the sandbox extension.
 *
 * A background command must be confined exactly as the bash tool is, so the
 * wrap is taken from the sandbox extension itself — it is the only place that
 * knows the initialized jail and its post-processing — never rebuilt here. Both
 * the marker and the wrap are published on `globalThis`; either one missing
 * means bash is not really sandboxed, and the runner refuses.
 */

export type SandboxWrap = (command: string) => Promise<string>;

export type Globals = {
  __codassSandbox?: { active: boolean; reason?: string };
  __codassSandboxWrap?: SandboxWrap;
};

export const NO_SANDBOX =
  "background: the sandbox extension is not in force, so a background command would run unconfined";

/** The wrap to run background commands through, or why there is none. */
export function resolveWrap(
  globals: Globals,
): { wrap: SandboxWrap } | { refusal: string } {
  const marker = globals.__codassSandbox;
  if (!marker) return { refusal: `${NO_SANDBOX} (no sandbox marker)` };
  if (!marker.active) {
    return { refusal: `${NO_SANDBOX} (${marker.reason ?? "inactive"})` };
  }
  const wrap = globals.__codassSandboxWrap;
  if (!wrap) return { refusal: `${NO_SANDBOX} (it publishes no wrap)` };
  return { wrap };
}
