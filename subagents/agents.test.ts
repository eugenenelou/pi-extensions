import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DEFAULT_AGENT_NAME, discoverAgents } from "./agents.ts";

test("discovery always provides a built-in default agent", () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-subagent-default-"));
  try {
    const agent = discoverAgents(cwd).agents.find(({ name }) => name === DEFAULT_AGENT_NAME);
    assert.ok(agent);
    assert.equal(agent.source, "builtin");
    assert.equal(agent.tools, undefined);
    assert.match(agent.systemPrompt, /general-purpose implementation subagent/i);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("a project agent named default overrides the built-in", () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-subagent-default-"));
  try {
    const agentsDir = join(cwd, ".pi", "agents");
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(join(agentsDir, "default.md"), [
      "---",
      "name: default",
      "description: project default",
      "tools: read",
      "---",
      "Project instructions.",
    ].join("\n"));

    const agent = discoverAgents(cwd).agents.find(({ name }) => name === DEFAULT_AGENT_NAME);
    assert.ok(agent);
    assert.equal(agent.source, "project");
    assert.deepEqual(agent.tools, ["read"]);
    assert.equal(agent.systemPrompt.trim(), "Project instructions.");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
