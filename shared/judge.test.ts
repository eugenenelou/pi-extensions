/**
 * Run with:
 *   node --experimental-strip-types --test shared/judge.test.ts
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type ConfigBases, configPath } from "./config.ts";
import { judgeModel } from "./judge.ts";

const roots: string[] = [];

function deploy(files: { global?: unknown; project?: unknown }): ConfigBases {
  const root = mkdtempSync(join(tmpdir(), "pi-judge-"));
  roots.push(root);
  const bases: ConfigBases = {
    agentDir: join(root, "agent"),
    cwd: join(root, "project"),
    configDirName: ".pi",
  };
  for (const [scope, setting] of Object.entries(files)) {
    const path = configPath("judge.json", scope as "global" | "project", bases);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(setting));
  }
  return bases;
}

const sessionModel = { id: "session" };

const context = () =>
  ({
    model: sessionModel,
    modelRegistry: {
      getModel: (provider: string, model: string) => ({
        id: `${provider}/${model}`,
      }),
    },
  }) as unknown as ExtensionContext;

test("the project judge.json overrides the agent-dir one", () => {
  const bases = deploy({
    global: { provider: "anthropic", model: "haiku", thinking: "low" },
    project: { provider: "openai", model: "mini" },
  });
  const { model, thinking } = judgeModel(context(), bases);
  assert.equal((model as unknown as { id: string }).id, "openai/mini");
  assert.equal(thinking, "low");
});

test("with no judge deployed the session's own model answers", () => {
  const { model } = judgeModel(context(), deploy({}));
  assert.equal(model, sessionModel);
});

test.after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});
