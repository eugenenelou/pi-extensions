import { createHash, randomUUID } from "node:crypto";
import type { FolderGrant } from "./filesystem-policy.ts";
import type { PermissionConfig } from "./permissions.ts";
import type {
  DelegationApprovalDecision,
  DelegationApprovalRequest,
} from "../subagents/approval-dialog.ts";

export const INHERITED_POLICY_ENV = "CODASS_INHERITED_POLICY";
export const SANDBOX_BOOTSTRAP_TIMEOUT_MS = 15_000;
export const DELEGATED_POLICY_READY_TIMEOUT_MS = 30_000;
/** Keep below Linux's usual 128 KiB per-environment-string ceiling. */
export const MAX_INHERITED_POLICY_BYTES = 96 * 1024;
export const MAX_DELEGATION_APPROVALS = 32;

export type ExactFileRead = { path: string };

/**
 * A session approval carried to descendants. The nested policy is always a
 * bare authority snapshot (it never contains more remembered approvals), so
 * inheritance cannot create a recursively growing or self-authorizing token.
 */
export type DelegationApprovalMemory = {
  target: string;
  access: "read" | "read-write";
  permission: "directory" | "target-project";
  policy: EffectivePolicy;
};

export type EffectivePolicy = {
  version: 1;
  filesystem: Record<string, unknown>;
  sandbox: Record<string, unknown>;
  permissions: PermissionConfig;
  /** Tool names active in the session that issued this policy. */
  tools: string[];
  /** Target mode lets Pi load that project's normal active tool set. */
  toolMode?: "inherited" | "target-project";
  /** Canonical project root authorized for target-project resource loading. */
  targetProjectRoot?: string;
  /** Hash of target project resources whose change invalidates remembered approval. */
  projectResourcesFingerprint?: string;
  grants: FolderGrant[];
  exactReads: ExactFileRead[];
  /** Session-scoped delegation approvals inherited by this session. */
  delegationApprovals?: DelegationApprovalMemory[];
};

export type DelegationAuthorization = {
  decision: DelegationApprovalDecision;
  policy: EffectivePolicy;
  projectTrusted: boolean;
};

export type FilesystemApprovalRequest = {
  requestId: string;
  requester: string;
  path: string;
  access: "read" | "read-write";
  reason: string;
};

export type FilesystemApprovalDecision =
  | {
      duration: "operation" | "conversation";
      /** Exact reads can cross a read protection without opening neighboring files. */
      kind: "directory" | "exact-file";
    }
  | undefined;

export type PermissionBroker = {
  snapshot(): EffectivePolicy;
  authorizeDelegation(
    request: DelegationApprovalRequest,
    signal?: AbortSignal,
  ): Promise<DelegationAuthorization | undefined>;
  requestFilesystem(
    request: FilesystemApprovalRequest,
    signal?: AbortSignal,
  ): Promise<FilesystemApprovalDecision>;
  applyFilesystemDecision(
    request: FilesystemApprovalRequest,
    decision: FilesystemApprovalDecision,
    executionId?: string,
  ): void;
  resolveTargetPolicy(target: string): EffectivePolicy;
  validateDelegation(
    target: string,
    access: "read" | "read-write",
    authorization: DelegationAuthorization,
  ): boolean;
};

export type PermissionGlobals = {
  __codassPermissionBroker?: PermissionBroker;
};

export function bareEffectivePolicy(policy: EffectivePolicy): EffectivePolicy {
  const { delegationApprovals: _approvals, ...bare } = policy;
  return structuredClone(bare) as EffectivePolicy;
}

/** Approval memory is latent authority, not part of the active policy extent. */
export function policyFingerprint(policy: EffectivePolicy): string {
  return createHash("sha256")
    .update(JSON.stringify(bareEffectivePolicy(policy)))
    .digest("hex");
}

export function delegationMemoryKey(
  target: string,
  access: "read" | "read-write",
  decision: DelegationApprovalDecision,
  policy: EffectivePolicy,
): string {
  return [target, access, decision.permission, policyFingerprint(policy)].join(
    "\0",
  );
}

export function makeDelegationRequest(
  requester: string,
  target: string,
  access: "read" | "read-write",
  directoryEffect: string,
  targetProjectEffect: string,
): DelegationApprovalRequest {
  return {
    requestId: randomUUID(),
    requester,
    target,
    access,
    directoryEffect,
    targetProjectEffect,
  };
}

function isEffectivePolicy(value: unknown, allowMemory: boolean): value is EffectivePolicy {
  if (!value || typeof value !== "object") return false;
  const policy = value as Partial<EffectivePolicy>;
  if (
    policy.version !== 1 ||
    !policy.filesystem || typeof policy.filesystem !== "object" ||
    !policy.sandbox || typeof policy.sandbox !== "object" ||
    !policy.permissions || typeof policy.permissions !== "object"
  ) return false;
  if (!Array.isArray(policy.tools) || !policy.tools.every((tool) => typeof tool === "string"))
    return false;
  if (
    policy.toolMode !== undefined &&
    policy.toolMode !== "inherited" &&
    policy.toolMode !== "target-project"
  ) return false;
  if (
    policy.targetProjectRoot !== undefined &&
    typeof policy.targetProjectRoot !== "string"
  ) return false;
  if (
    policy.projectResourcesFingerprint !== undefined &&
    typeof policy.projectResourcesFingerprint !== "string"
  ) return false;
  if (
    policy.toolMode === "target-project" &&
    (!policy.targetProjectRoot || !policy.projectResourcesFingerprint)
  ) return false;
  if (
    !Array.isArray(policy.grants) ||
    !policy.grants.every(
      (grant) =>
        grant &&
        typeof grant === "object" &&
        typeof (grant as FolderGrant).root === "string" &&
        ((grant as FolderGrant).mode === "read" ||
          (grant as FolderGrant).mode === "read-write"),
    )
  ) return false;
  if (
    !Array.isArray(policy.exactReads) ||
    !policy.exactReads.every(
      (entry) =>
        entry &&
        typeof entry === "object" &&
        typeof (entry as ExactFileRead).path === "string",
    )
  ) return false;
  if (policy.delegationApprovals === undefined) return true;
  if (
    !allowMemory ||
    !Array.isArray(policy.delegationApprovals) ||
    policy.delegationApprovals.length > MAX_DELEGATION_APPROVALS
  ) return false;
  return policy.delegationApprovals.every((entry) =>
    Boolean(entry) &&
    typeof entry === "object" &&
    typeof entry.target === "string" &&
    (entry.access === "read" || entry.access === "read-write") &&
    (entry.permission === "directory" || entry.permission === "target-project") &&
    isEffectivePolicy(entry.policy, false) &&
    entry.policy.delegationApprovals === undefined,
  );
}

export function parseEffectivePolicy(
  text: string | undefined,
): EffectivePolicy | undefined {
  if (!text || Buffer.byteLength(text, "utf8") > MAX_INHERITED_POLICY_BYTES)
    return undefined;
  try {
    const value: unknown = JSON.parse(text);
    return isEffectivePolicy(value, true) ? value : undefined;
  } catch {
    return undefined;
  }
}
