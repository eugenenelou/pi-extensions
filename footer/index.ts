/**
 * Custom footer: pi's own footer, minus the extension-status line, with the
 * context fragment showing the tokens used, not only the percentage.
 *
 * The built-in `FooterComponent` is a public export, so it is constructed here
 * with the extension context standing in for the internal `AgentSession` and
 * its output is post-processed. Anything that fails falls back to pi's footer.
 */

import {
  type ExtensionAPI,
  type ExtensionContext,
  FooterComponent,
} from "@earendil-works/pi-coding-agent";
import { backgroundLine, fitToWidth, rewriteContextFragment } from "./render.ts";

/** The running tasks the background extension publishes, if it is loaded. */
function backgroundTasks(): { id: string; command: string }[] {
  const list = (
    globalThis as {
      __codassBackgroundTasks?: () => { id: string; command: string }[];
    }
  ).__codassBackgroundTasks;
  try {
    return list?.() ?? [];
  } catch {
    return [];
  }
}

/** The fields of pi's internal `AgentSession` that `FooterComponent` reads. */
function footerSession(ctx: ExtensionContext) {
  return {
    get state() {
      return { model: ctx.model, thinkingLevel: ctx.thinkingLevel };
    },
    sessionManager: ctx.sessionManager,
    getContextUsage: () => ctx.getContextUsage(),
    // No public source: extensions cannot see the model runtime, so a
    // subscription-backed provider loses its "(sub)" marker.
    modelRuntime: { isUsingSubscription: () => false },
  };
}

function applyCustomFooter(ctx: ExtensionContext): void {
  ctx.ui.setFooter((tui, _theme, footerData) => {
    try {
      const builtIn = new FooterComponent(
        footerSession(ctx) as never,
        footerData,
      );
      const unsubscribe = footerData.onBranchChange(() => tui.requestRender());
      return {
        render(width: number): string[] {
          // Lines 0 and 1 are pwd and stats; anything after is the
          // extension-status line, which is what we drop.
          const builtInLines = builtIn.render(width).slice(0, 2);
          try {
            const lines = [...builtInLines];
            if (lines.length > 1) {
              lines[1] = rewriteContextFragment(
                lines[1],
                ctx.getContextUsage()?.tokens,
              );
            }
            const background = backgroundLine(backgroundTasks(), width);
            if (background) lines.push(background);
            // The TUI aborts on any line wider than the terminal, and the
            // rewrite is longer than what it replaces.
            return lines.map((line) => fitToWidth(line, width));
          } catch {
            return builtInLines;
          }
        },
        invalidate: () => builtIn.invalidate(),
        dispose: () => {
          unsubscribe();
          builtIn.dispose();
        },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.ui.notify(
        `codass footer: falling back to the built-in footer: ${message}`,
        "warning",
      );
      queueMicrotask(() => ctx.ui.setFooter(undefined));
      return { render: () => [] };
    }
  });
}

export default function (pi: ExtensionAPI) {
  let custom = true;

  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui" || !custom) return;
    applyCustomFooter(ctx);
  });

  pi.registerCommand("footer", {
    description: "Toggle the codass footer against pi's built-in one",
    handler: async (_args, ctx) => {
      custom = !custom;
      if (custom) {
        applyCustomFooter(ctx);
        ctx.ui.notify("codass footer enabled", "info");
      } else {
        ctx.ui.setFooter(undefined);
        ctx.ui.notify("Built-in footer restored", "info");
      }
    },
  });
}
