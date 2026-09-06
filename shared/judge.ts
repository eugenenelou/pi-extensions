/**
 * The `judge` model role codass renders beside the extension configs, read by
 * every extension that asks a small model a question. The project layer wins
 * over the agent-dir one; with neither, the session's own model answers.
 */

import type { Api, Model, ThinkingLevel } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type ConfigBases, mergedConfig } from "./config.ts";

interface JudgeSetting {
  provider?: string;
  model?: string;
  thinking?: ThinkingLevel;
}

export function judgeModel(
  ctx: ExtensionContext,
  bases: ConfigBases,
): { model: Model<Api> | undefined; thinking?: ThinkingLevel } {
  const setting = mergedConfig<JudgeSetting>("judge.json", bases);
  const model =
    setting.provider && setting.model
      ? ctx.modelRegistry.getModel(setting.provider, setting.model)
      : undefined;
  return { model: model ?? ctx.model, thinking: setting.thinking };
}
