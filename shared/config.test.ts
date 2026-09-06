/**
 * Run with:
 *   node --experimental-strip-types --test shared/config.test.ts
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import {
  type ConfigBases,
  configLayers,
  configPath,
  configValues,
  mergedConfig,
} from "./config.ts";

const roots: string[] = [];

function bases(files: { global?: string; project?: string }): ConfigBases {
  const root = mkdtempSync(join(tmpdir(), "pi-config-"));
  roots.push(root);
  const made: ConfigBases = {
    agentDir: join(root, "agent"),
    cwd: join(root, "project"),
    configDirName: ".pi",
  };
  for (const [scope, text] of Object.entries(files)) {
    const path = configPath("demo.json", scope as "global" | "project", made);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  }
  return made;
}

test("both layers use the same relative path", () => {
  const made = bases({});
  assert.equal(
    configPath("demo.json", "global", made),
    join(made.agentDir, "extensions", "demo.json"),
  );
  assert.equal(
    configPath("demo.json", "project", made),
    join(made.cwd, ".pi", "extensions", "demo.json"),
  );
});

test("an absent file is not an unreadable one", () => {
  const layers = configLayers("demo.json", bases({ project: "{ not json" }));
  assert.equal(layers.global.doc.state, "absent");
  assert.equal(layers.project.doc.state, "unreadable");
});

test("a non-object document reads as unreadable", () => {
  const layers = configLayers("demo.json", bases({ global: "[1]" }));
  assert.equal(layers.global.doc.state, "unreadable");
});

test("only the layers that parsed contribute a value, global first", () => {
  const made = bases({ global: '{"a":1}', project: '{"a":2,"b":3}' });
  assert.deepEqual(configValues(configLayers("demo.json", made)), [
    { a: 1 },
    { a: 2, b: 3 },
  ]);
  assert.deepEqual(mergedConfig("demo.json", made), { a: 2, b: 3 });
});

test.after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});
