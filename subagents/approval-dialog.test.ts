import assert from "node:assert/strict";
import test from "node:test";
import {
  DelegationApprovalDialog,
  type DelegationApprovalDecision,
  type DelegationApprovalRequest,
} from "./approval-dialog.ts";

const request: DelegationApprovalRequest = {
  requestId: "request-1",
  requester: "builder",
  target: "/projects/other",
  access: "read-write",
  directoryEffect: "keeps inherited restrictions and adds only this directory",
  targetProjectEffect: "replaces inherited permissions and may reach other paths",
};

function fixture() {
  const decisions: Array<DelegationApprovalDecision | undefined> = [];
  let changes = 0;
  const dialog = new DelegationApprovalDialog(request, (value) => decisions.push(value), () => changes++);
  return { dialog, decisions, changes: () => changes };
}

test("defaults are directory access for this run and render the request extent", () => {
  const f = fixture();
  assert.equal(f.dialog.permission, "directory");
  assert.equal(f.dialog.duration, "run");
  const text = f.dialog.render(100).join("\n");
  assert.match(text, /builder/);
  assert.match(text, /\/projects\/other/);
  assert.match(text, /read and write/);
  assert.match(text, /keeps inherited restrictions/);
  assert.match(text, /may reach other paths/);
  assert.deepEqual(f.decisions, []);
});

test("radio groups change independently and selection never submits", () => {
  const f = fixture();
  f.dialog.handleInput("\x1b[B");
  assert.equal(f.dialog.permission, "target-project");
  assert.equal(f.dialog.duration, "run");
  f.dialog.handleInput("\t");
  f.dialog.handleInput("\x1b[B");
  assert.equal(f.dialog.permission, "target-project");
  assert.equal(f.dialog.duration, "session");
  assert.deepEqual(f.decisions, []);
  assert.ok(f.changes() >= 3);
});

test("Allow explicitly returns both selections; Cancel and Escape deny", () => {
  const allowed = fixture();
  allowed.dialog.handleInput("\x1b[B");
  allowed.dialog.handleInput("\t");
  allowed.dialog.handleInput("\x1b[B");
  allowed.dialog.handleInput("\t");
  assert.deepEqual(allowed.decisions, []);
  allowed.dialog.handleInput("\r");
  assert.deepEqual(allowed.decisions, [{ permission: "target-project", duration: "session" }]);

  const cancelled = fixture();
  cancelled.dialog.handleInput("\t");
  cancelled.dialog.handleInput("\t");
  cancelled.dialog.handleInput("\x1b[C");
  cancelled.dialog.handleInput("\r");
  assert.deepEqual(cancelled.decisions, [undefined]);

  const escaped = fixture();
  escaped.dialog.handleInput("\x1b");
  assert.deepEqual(escaped.decisions, [undefined]);
});
