/**
 * The two config layers of a pi extension config file: `extensions/<name>`
 * under the agent dir, and the same relative path under the project config
 * dir (`.pi/extensions/<name>`). One layout for both layers, so a file
 * declared once is right for a rendered loop profile and for a worktree.
 *
 * The reader only reads: each extension keeps its own merge rule. Absent and
 * unreadable are distinguished so a reader that must fail closed can.
 *
 * Kept free of `@earendil-works/*` imports so it is testable on its own; the
 * caller passes the agent dir and pi's `CONFIG_DIR_NAME`.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface ConfigBases {
  agentDir: string;
  cwd: string;
  /** pi's project config dir name (`CONFIG_DIR_NAME`). */
  configDirName: string;
}

export type ConfigScope = "global" | "project";

export type ConfigDoc<T> =
  | { state: "absent" }
  | { state: "unreadable"; error: string }
  | { state: "present"; value: T };

export interface ConfigLayer<T> {
  path: string;
  doc: ConfigDoc<T>;
}

export interface ConfigLayers<T> {
  global: ConfigLayer<T>;
  project: ConfigLayer<T>;
}

export function configPath(
  name: string,
  scope: ConfigScope,
  bases: ConfigBases,
): string {
  const root =
    scope === "global" ? bases.agentDir : join(bases.cwd, bases.configDirName);
  return join(root, "extensions", name);
}

export function readConfig<T>(path: string): ConfigDoc<T> {
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    return { state: "absent" };
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { state: "unreadable", error: `${path}: not a JSON object` };
    }
    return { state: "present", value: parsed as T };
  } catch (err) {
    return {
      state: "unreadable",
      error: `${path}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

function configLayer<T>(
  name: string,
  scope: ConfigScope,
  bases: ConfigBases,
): ConfigLayer<T> {
  const path = configPath(name, scope, bases);
  return { path, doc: readConfig<T>(path) };
}

export function configLayers<T>(
  name: string,
  bases: ConfigBases,
): ConfigLayers<T> {
  return {
    global: configLayer<T>(name, "global", bases),
    project: configLayer<T>(name, "project", bases),
  };
}

/** The layers that hold a document, global first. */
export function configValues<T>(layers: ConfigLayers<T>): T[] {
  return [layers.global, layers.project].flatMap((layer) =>
    layer.doc.state === "present" ? [layer.doc.value] : [],
  );
}

export function configErrors<T>(layers: ConfigLayers<T>): string[] {
  return [layers.global, layers.project].flatMap((layer) =>
    layer.doc.state === "unreadable" ? [layer.doc.error] : [],
  );
}

/** Project layer over global layer, shallow. */
export function mergedConfig<T extends object>(
  name: string,
  bases: ConfigBases,
): Partial<T> {
  return Object.assign({}, ...configValues<T>(configLayers<T>(name, bases)));
}
