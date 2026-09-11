import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  DELEGATED_POLICY_READY_TIMEOUT_MS,
  MAX_DELEGATION_APPROVALS,
  MAX_INHERITED_POLICY_BYTES,
  SANDBOX_BOOTSTRAP_TIMEOUT_MS,
  parseEffectivePolicy,
  policyFingerprint,
  type EffectivePolicy,
} from "./authorization.ts";
import {
  delegatedAuthorizationMatches,
  PROJECT_FINGERPRINT_MAX_FILE_BYTES,
  projectResourcesFingerprint,
} from "./index.ts";

const policy: EffectivePolicy = {
  version: 1,
  sandbox: { enabled: true },
  filesystem: { allowWrite: ["/project"] },
  permissions: {},
  tools: ["read"],
  toolMode: "inherited",
  grants: [],
  exactReads: [],
};

test("delegation waits longer than sandbox bootstrap", () => {
  assert.ok(DELEGATED_POLICY_READY_TIMEOUT_MS > SANDBOX_BOOTSTRAP_TIMEOUT_MS);
});

test("inherited policy parsing rejects malformed capability payloads", () => {
  assert.deepEqual(parseEffectivePolicy(JSON.stringify(policy)), policy);
  assert.equal(
    parseEffectivePolicy(JSON.stringify({ ...policy, toolMode: "anything" })),
    undefined,
  );
  assert.equal(
    parseEffectivePolicy(
      JSON.stringify({ ...policy, grants: [{ root: "/tmp", mode: "write" }] }),
    ),
    undefined,
  );
  assert.equal(
    parseEffectivePolicy(
      JSON.stringify({ ...policy, exactReads: [{ path: 42 }] }),
    ),
    undefined,
  );
});

test("policy fingerprints include active extent but exclude latent approval memory", () => {
  const first = policyFingerprint({
    ...policy,
    projectResourcesFingerprint: "one",
  });
  const secondPolicy: EffectivePolicy = {
    ...policy,
    projectResourcesFingerprint: "two",
  };
  const second = policyFingerprint(secondPolicy);
  assert.notEqual(first, second);
  assert.equal(
    policyFingerprint({
      ...secondPolicy,
      delegationApprovals: [{
        target: "/elsewhere",
        access: "read",
        permission: "directory",
        policy,
      }],
    }),
    second,
  );
});

test("inherited policy parsing accepts bounded approval memory and rejects recursive tokens", () => {
  const withMemory: EffectivePolicy = {
    ...policy,
    delegationApprovals: [{
      target: "/other",
      access: "read-write",
      permission: "target-project",
      policy: {
        ...policy,
        toolMode: "target-project",
        targetProjectRoot: "/other",
        projectResourcesFingerprint: "resources",
      },
    }],
  };
  assert.deepEqual(parseEffectivePolicy(JSON.stringify(withMemory)), withMemory);
  const recursive = structuredClone(withMemory);
  recursive.delegationApprovals![0].policy.delegationApprovals = [];
  assert.equal(parseEffectivePolicy(JSON.stringify(recursive)), undefined);

  const tooMany = structuredClone(withMemory);
  tooMany.delegationApprovals = Array.from(
    { length: MAX_DELEGATION_APPROVALS + 1 },
    () => structuredClone(withMemory.delegationApprovals![0]),
  );
  assert.equal(parseEffectivePolicy(JSON.stringify(tooMany)), undefined);
  assert.equal(
    parseEffectivePolicy(" ".repeat(MAX_INHERITED_POLICY_BYTES + 1)),
    undefined,
  );
});

test("delegation validation accepts unchanged in-scope authority and only the requested expansion", () => {
  const inherited: EffectivePolicy = {
    ...policy,
    filesystem: { allowWrite: ["/project"] },
  };
  assert.equal(
    delegatedAuthorizationMatches(
      inherited,
      undefined,
      "/project",
      "read-write",
      {
        decision: { permission: "directory", duration: "run" },
        policy: inherited,
        projectTrusted: false,
      },
      "/project",
    ),
    true,
  );
  const expanded: EffectivePolicy = {
    ...inherited,
    grants: [{ root: "/other", mode: "read" }],
  };
  assert.equal(
    delegatedAuthorizationMatches(
      inherited,
      undefined,
      "/other",
      "read",
      {
        decision: { permission: "directory", duration: "run" },
        policy: expanded,
        projectTrusted: false,
      },
      "/project",
    ),
    true,
  );
  assert.equal(
    delegatedAuthorizationMatches(
      inherited,
      undefined,
      "/other",
      "read-write",
      {
        decision: { permission: "directory", duration: "run" },
        policy: expanded,
        projectTrusted: false,
      },
      "/project",
    ),
    false,
  );
});

test("target resource fingerprinting fails closed on oversized unapproved resources", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-target-oversized-"));
  try {
    mkdirSync(join(root, ".pi"), { recursive: true });
    writeFileSync(
      join(root, ".pi", "oversized.bin"),
      Buffer.alloc(PROJECT_FINGERPRINT_MAX_FILE_BYTES + 1),
    );
    assert.throws(
      () => projectResourcesFingerprint(root),
      /trust resource is too large/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("target resource fingerprints change with files and followed symlink targets", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-target-resources-"));
  const outside = mkdtempSync(join(tmpdir(), "pi-target-extension-"));
  try {
    mkdirSync(join(root, ".pi", "extensions"), { recursive: true });
    const extension = join(outside, "extension.ts");
    writeFileSync(extension, "export default () => 1;\n");
    symlinkSync(extension, join(root, ".pi", "extensions", "linked.ts"));
    const initial = projectResourcesFingerprint(root);

    writeFileSync(extension, "export default () => 2;\n");
    const changedLinkTarget = projectResourcesFingerprint(root);
    assert.notEqual(changedLinkTarget, initial);

    writeFileSync(join(root, ".pi", "settings.json"), '{"packages":[]}\n');
    assert.notEqual(projectResourcesFingerprint(root), changedLinkTarget);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("target resource fingerprints include settings-referenced and ancestor resources", () => {
  const container = mkdtempSync(join(tmpdir(), "pi-target-external-resources-"));
  const target = join(container, "projects", "target");
  const external = join(container, "external-extension.ts");
  const ancestorSkill = join(container, ".agents", "skills", "review", "SKILL.md");
  try {
    mkdirSync(join(target, ".pi"), { recursive: true });
    mkdirSync(join(container, ".agents", "skills", "review"), { recursive: true });
    writeFileSync(external, "export default () => 1;\n");
    writeFileSync(ancestorSkill, "first\n");
    writeFileSync(
      join(target, ".pi", "settings.json"),
      JSON.stringify({ extensions: [external] }),
    );
    const initial = projectResourcesFingerprint(target);

    writeFileSync(external, "export default () => 2;\n");
    const changedExternal = projectResourcesFingerprint(target);
    assert.notEqual(changedExternal, initial);

    writeFileSync(ancestorSkill, "second\n");
    assert.notEqual(projectResourcesFingerprint(target), changedExternal);
  } finally {
    rmSync(container, { recursive: true, force: true });
  }
});
