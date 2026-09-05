# Handoff: pi as a codass deploy target

Written 2026-09-05 after a grilling session. Section 1 is the goal to execute.
Sections 2-5 are facts already verified; do not re-research them, but verify a
file or flag still exists before relying on it.

## 1. GOAL

pi as a codass deploy target, at parity with my Claude setup.

Decisions (fixed):

- New codass target `pi` in `codass/codass_cli` (deploy, doctor, validate,
  launchers), generated from the same packs/subagents/mcps/models.yaml as the
  other targets. Existing targets untouched.
- codass generates per worktree:
  - `.pi/settings.json`: `packages` (pi-mcp-adapter) + `extensions` absolute
    paths into the extensions repo.
  - `.pi/extensions/codass-hooks.ts`: rtk rewrite on `tool_call`,
    format-on-edit on `tool_execution_end`, command guard on `tool_call`
    (`git push`, `git stash`, `git -C`, git `--force`, `rm -rf` outside /tmp,
    `sudo`: ask in TUI, block in `-p`).
  - `.pi/sandbox.json`: allowWrite worktree + /tmp + scratchpad; denyWrite
    `.env*`; denyRead `~/.ssh ~/.aws ~/.gnupg`; network open.
  - `.pi/agents/*.md` from subagents: model from models.yaml roles for target
    `pi` (codex ids, effort as thinking level); inline mcps carried per agent.
  - `.pi/prompts/` from commands; `.pi/skills/` symlinks; MCP config for
    pi-mcp-adapter from mcps.yaml (reuse the generated `.mcp.json` if the
    format fits, it does for stdio and http, see 4.3).
  - loop-handoff hook NOT ported; loops stay claude-only.
- Hand-written extensions live in this repo, `~/projects/pi-extensions/`
  (empty at handoff time). Contents:
  - `subagents`: own, based on pi-mono `examples/extensions/subagent`.
    Markdown agents, spawns `pi -p -a` children with role model + thinking,
    tools allowlist, inline MCP config via pi-mcp-adapter `createMcpAdapter`.
    Nesting works because children load the same extension. Parallel mode.
  - `sandbox`: vendored from pi-mono `examples/extensions/sandbox`
    (`@anthropic-ai/sandbox-runtime`, bubblewrap).
  - codass references the repo by absolute path in `settings.json`.
- MCP: `pi-mcp-adapter` package (stdio + http + oauth). Linear filter proxy
  optional under pi (the adapter already proxies tools, so context size is not
  the reason anymore).
- Model ids: `openai-codex/gpt-5.6-{sol,terra,luna}`; roles per models.yaml.

Acceptance (test yourself via `pi -p`; Eugène smoke-tests the TUI after):

1. `codass deploy pi` in the atlas worktree; `codass doctor` green;
   claude/opencode/codex/cursor outputs unchanged.
2. `pi` starts on openai-codex with role main = gpt-5.6-sol@high; rules +
   skills in context.
3. main -> builder -> lint-fixer nested spawn returns results; each child on its
   role model.
4. playwright MCP callable from main; `linear` subagent reaches Linear via
   inline MCP, parent session never loads Linear tools.
5. `git status` output rtk-trimmed; editing a `.py` file triggers ruff;
   `git push` blocked in `-p`.
6. Write to `.env` fails; write in worktree succeeds; bash cannot read `~/.ssh`.

Rules: pi binary is `~/.local/share/pnpm/pi` (pnpm global shim, not on the
sandbox PATH). Work on a branch in atlas (codass + .code_assistant) and commit
per slice in both repos, never push. Follow existing codass target patterns
(opencode is the template). Tests: pytest for codass generation; `pi -p` runs
for runtime. When blocked on a fact, look it up; when blocked on a decision,
pick the option closest to the claude target and note it in the final report.
No attribution lines in commits.

## 2. Machine state (verified 2026-09-05)

- pi 0.85.0, package `@earendil-works/pi-coding-agent` (the old
  `@mariozechner/pi-coding-agent` is deprecated). Installed with
  `pnpm add -g`, shim at `~/.local/share/pnpm/pi`.
- `~/.pi/agent/auth.json` has an `openai-codex` entry (access/refresh/expires/
  accountId). `~/.pi/agent/settings.json` currently:
  `defaultProvider: openai-codex`, `defaultModel: gpt-5.5`.
- `pi --list-models` openai-codex rows: gpt-5.3-codex-spark, gpt-5.4,
  gpt-5.4-mini, gpt-5.5, gpt-5.6-luna, gpt-5.6-sol, gpt-5.6-terra, gpt-6-astra.
- `bwrap` 0.9.0 at /usr/bin/bwrap. Sandbox example also needs socat + ripgrep
  on Linux (check `which socat rg`).
- codex CLI 0.151 logged in at `~/.codex` (irrelevant to pi, separate auth).
- rtk 0.45.0 at `~/.local/bin/rtk`. Node via fnm, pnpm 10.33.

## 3. codass, the target to extend

Source: `~/projects/atlas/codass/` (editable install, `codass_cli/`).
Config for atlas: `~/projects/atlas/.code_assistant/`.

- `codass_cli/models.py:30` `class Platform(str, enum.Enum)`: cursor, claude,
  codex, opencode. Add `pi`.
- `codass_cli/deploy.py` (1823 lines): `deploy_cursor` ~682, `deploy_claude`
  ~883, `deploy_codex` ~1607, `deploy_opencode` ~1650 (the template: agents,
  commands, rules, skills symlinks, `opencode.json` with mcp + overrides,
  `_apply_opencode_subagent_model`, `_build_opencode_mcp_config`,
  `_resolve_subagent_model`, `_inject_claude_subagent_mcps`,
  `_strip_inline_mcps`, `_build_claude_hooks`, `_clean_stale_artifacts`,
  `_ensure_symlink`, `_deep_merge`).
- `codass_cli/cli.py:817` `deploy(platform)`, help string lists the platforms.
- `codass_cli/model_registry.py`: per-platform effort validation (codex path
  ~196, opencode variants ~203). `pi` needs: model id per name + effort ->
  pi thinking level (off, minimal, low, medium, high, xhigh, max).
- `codass_cli/sessions/launchers.py`: `LAUNCH_COMMANDS`, `LAUNCH_PRIORITY`,
  `LOOP_CAPABLE_PLATFORMS` (keep claude only), `LOOP_LAUNCH_FLAGS`.
- Tests: `codass/tests/test_deploy_opencode.py`, `test_deploy_targets.py`,
  `test_deploy_subagent_mcps.py`, `test_deploy_subagent_models.py`,
  `test_launchers.py`, `test_deploy_platform_overrides.py`. Mirror for pi.
- Config files: `config.yaml` (`deploy_targets: [claude]`, add `pi`),
  `packs.yaml`, `profiles.yaml` (active: full), `models.yaml` (flat lists per
  platform, `models:` canonical names, `roles:` main/builder/search/debug/
  review/plan/runner per platform, `opencode_variants`), `mcps.yaml` +
  `mcps.local.yaml` (tokens), `overrides.example.yaml`.
- Subagents: `.code_assistant/subagents/{atlas-core,atlas-backend,
atlas-importers,cyril,eugene}/*.md`. Frontmatter today: name, description,
  tools, model (role or name), permission map, and for some an inline
  `mcpServers` list (linear, notion-writer own their MCP so the parent never
  loads it; memory says inline mcpServers must be a list of single-key maps).
- Hooks: `packs/atlas-core/hooks.yaml` declares
  `event: PostToolUse, matcher: Write|Edit, script: hooks/atlas-core/format-on-edit.sh`.
  The rtk hook is NOT codass-managed: it is `rtk hook claude` as a global
  PreToolUse Bash hook in `~/.claude/settings.json`. For pi, generate it
  unconditionally in codass-hooks.ts.
- Existing generated artifacts to compare against: `.claude/`, `.opencode/`
  (agents/codass, commands/codass, rules, skills, opencode.json), `.mcp.json`.

## 4. pi facts (from docs at pi-mono main, 2026-09-05)

### 4.1 Layout and discovery

- Global: `~/.pi/agent/{settings.json,auth.json,extensions,skills,prompts,
themes,agents(subagent ext)}`. Project: `.pi/{settings.json,extensions,
skills,prompts,themes,SYSTEM.md,APPEND_SYSTEM.md}`, plus `.agents/skills/`.
- Context files: `AGENTS.md` and `CLAUDE.md` are loaded (cwd + parents +
  `~/.pi/agent/AGENTS.md`), override with `AGENTS.override.md`. So the
  existing `.claude/CLAUDE.md` rules chain may already load; check what pi
  picks up from `~/projects/atlas/CLAUDE.md` vs `.claude/CLAUDE.md`.
- Extension discovery: `~/.pi/agent/extensions/*.ts` or `*/index.ts`;
  `.pi/extensions/*.ts` or `*/index.ts` (project, after trust).
- `settings.json` keys: `packages: ["npm:pkg@ver", "git:github.com/u/r@v1"]`,
  `extensions: ["/abs/path.ts", "/abs/dir"]`, `defaultProvider`,
  `defaultModel`, `defaultProjectTrust: ask|always|never`.
- Package layout: `package.json` with `"pi": {"extensions": [...],
"skills": [...], "prompts": [...], "themes": [...]}`; deps install to
  `~/.pi/agent/cache/`.
- Project trust (docs/security.md): `.pi/settings.json`, `.pi/extensions`,
  skills, prompts, SYSTEM.md, `.agents/skills` require trust. Interactive:
  prompt, saved in `~/.pi/agent/trust.json`. Non-interactive (`-p`, `--mode
json|rpc`): no prompt; `ask`/`never` IGNORE project resources unless a saved
  decision exists; `--approve`/`-a` trusts for one run, `--no-approve`/`-na`
  ignores. Subagent children MUST pass `-a` (or rely on a saved trust).
- CLI flags (0.85): `--provider`, `--model <pattern>` (supports
  `provider/id` and `:<thinking>` suffix), `--thinking off|minimal|low|medium|
high|xhigh|max`, `-p/--print`, `--mode text|json|rpc`, `-e <path>`,
  `--no-extensions`, `--tools a,b`, `--exclude-tools`, `--no-builtin-tools`,
  `--skill`, `--no-skills`, `--prompt-template`, `--no-context-files`,
  `--append-system-prompt <text|file>`, `--system-prompt`, `--session-dir`,
  `--no-session`, `-a/-na`, `--offline`.

### 4.2 Extension API

`export default function (pi: ExtensionAPI) { ... }`. Events via `pi.on`:

- Tools: `tool_call` (blockable; return `{block: true, reason}` or modify
  `event.input`), `tool_result` (modifiable), `tool_execution_start/update/
end`. Built-in tool names: `read`, `write`, `edit`, `bash`, `grep`, `find`,
  `ls`. Inputs: bash `{command}`, write/edit `{path, ...}`.
- Session: `session_start`, `session_shutdown`, `session_before_compact`,
  `session_compact`, `resources_discover` (contribute skill/prompt paths),
  `project_trust`.
- Agent: `before_agent_start` (modify system prompt), `agent_start`,
  `agent_end`, `agent_settled`, `turn_start`, `turn_end`, `context`,
  `before_provider_request`.
- Input: `input`, `user_bash`.
- `ctx.hasUI`, `ctx.ui.select(msg, choices)`, `ctx.ui.notify(msg, level)`,
  `pi.sendUserMessage()`, `pi.registerTool({name, label, description,
promptSnippet, promptGuidelines, parameters: TypeBox, execute(toolCallId,
params, signal, onUpdate, ctx) -> {content, details, usage?, terminate?}})`.
- Tools must truncate output (~50KB / 2000 lines). Use
  `withFileMutationQueue()` for file edits.
- Reference examples in pi-mono `packages/coding-agent/examples/extensions/`:
  `permission-gate.ts` (regex on bash command, `ctx.ui.select` or block
  without UI), `protected-paths.ts` (block write/edit by path),
  `confirm-destructive.ts`, `bash-spawn-hook.ts`, `sandbox/` (dir:
  index.ts + package.json), `subagent/` (dir), `gondolin/`, `plan-mode/`,
  `claude-rules.ts` (probably loads .claude rules, read it), `handoff.ts`,
  `kimi-deferred-tools.ts`, `dynamic-tools.ts`, `dynamic-resources/`.
  Fetch raw with
  `https://raw.githubusercontent.com/badlogic/pi-mono/main/packages/coding-agent/<path>`;
  list dirs with `gh api repos/badlogic/pi-mono/contents/<path>`.
- Docs dir `packages/coding-agent/docs/`: extensions.md, packages.md,
  skills.md, prompt-templates.md, settings.md, providers.md, models.md,
  security.md, containerization.md, sdk.md, rpc.md, json.md, sessions.md,
  environment-variables.md. `sdk.md` has `createAgentSession` for in-process
  nested sessions if spawning `pi -p` proves awkward.

### 4.3 pi-mcp-adapter (v2.32.1, github nicobailon/pi-mcp-adapter)

- Install: `pi install npm:pi-mcp-adapter` or `packages` in settings.json.
- Config sources, ascending precedence: `~/.config/mcp/mcp.json`,
  `~/.agents/mcp.json`, `~/.agents/mcp/mcp.json`, `~/.pi/agent/mcp.json`,
  `.mcp.json` (project, Claude-compatible `mcpServers` format), `.pi/mcp.json`
  (project override, highest). Host configs (Claude, Codex) are only imported
  via `/mcp setup` or `pi-mcp-adapter init`, not auto-loaded.
- Server fields: stdio `command/args/env`; http `url`, `headers` with `${VAR}`
  / `$env:VAR` interpolation (value starting `!` runs a command);
  `auth: "bearer"|"oauth"`, `oauth.grantType authorization_code|
client_credentials`, `oauth.clientId/clientSecret/scope/redirectUri`,
  dynamic client registration fallback when clientId omitted. OAuth tokens in
  the OS credential store, keyed by server name + URL.
- Lazy by default: servers connect on first tool call. Exposes proxy tools
  (search/describe/call), not per-tool schemas. `disabled: true` per server.
- Programmatic: `createMcpAdapter({ config })` in-memory config (isolated,
  no file reads) for children; `pi-mcp-adapter/oauth` exports
  `getMcpOAuthTokensForUrl`.
- `/mcp` panel, `/reload` after config changes.
- Open question to settle during build: whether `${VAR:-default}` (bash-style
  default, used in mcps.yaml for STORYBOOK_PORT) is supported; if not, codass
  must resolve it at deploy time for pi.

### 4.4 Subagent example (pi-mono examples/extensions/subagent)

- Agents: markdown with frontmatter `name`, `description`, `tools`
  (comma-separated), `model` (optional). Locations `~/.pi/agent/agents/*.md`
  and `.pi/agents/*.md` (project needs `agentScope: "both"` config; project
  overrides user on name clash).
- Modes: single, parallel (max 8 tasks, 4 concurrent), chain with
  `{previous}`. Each subagent is a separate `pi` process with an isolated
  context; Ctrl+C propagates. Nesting undocumented: implement by making the
  extension load in children (children see `.pi/extensions` when `-a`).
- Presets it ships (`/implement`, `/scout-and-plan`, `/implement-and-review`)
  are NOT wanted; our commands come from codass.

### 4.5 Sandbox example (pi-mono examples/extensions/sandbox/index.ts)

- Overrides the built-in `bash` tool with `createBashTool` + a `BashOperations`
  whose `exec` wraps the command via `SandboxManager.wrapWithSandbox(command)`
  from `@anthropic-ai/sandbox-runtime` (bubblewrap on Linux, sandbox-exec on
  macOS). Same library Claude Code uses for its bash sandbox.
- Config merge: `~/.pi/agent/extensions/sandbox.json` then `<cwd>/.pi/
sandbox.json`. Keys: `enabled`, `network.allowedDomains/deniedDomains`,
  `filesystem.denyRead/allowWrite/denyWrite`, `ignoreViolations`,
  `enableWeakerNestedSandbox`. Defaults deny-read `~/.ssh ~/.aws ~/.gnupg`,
  allowWrite `. /tmp`, denyWrite `.env .env.* *.pem *.key`.
- Flags: `--no-sandbox`; `/sandbox` shows config. Setup: copy dir, `npm
install` inside. Linux needs bubblewrap, socat, ripgrep.
- Note: network allowlist defaults to npm/pypi/github only when `network` is
  set; the GOAL says network open in v1, so omit or empty the network block
  and verify that means unrestricted rather than deny-all.
- Nested pi children are spawned by the subagent extension, not through the
  sandboxed bash, so each child sandboxes itself. `enableWeakerNestedSandbox`
  exists if a bash-spawned nested bwrap ever appears.

### 4.6 Community stance on safety (for the record)

pi is YOLO by design; maintainers say isolation belongs to OS/containers
(docs/security.md, discussions #1874, #2520). Container patterns (Gondolin
micro-VM, plain Docker, OpenShell, Docker Sandboxes) were rejected for this
setup because the workflow needs the real checkout, worktrees, `just`, and
dev services on host localhost.

## 5. Hook contracts to preserve

- rtk: `echo '{"tool_name":"Bash","tool_input":{"command":"git status"}}' |
rtk hook claude` returns
  `{"hookSpecificOutput":{"updatedInput":{"command":"rtk git status"},
"permissionDecision":"allow",...}}`. There is no `rtk hook pi`; call
  `rtk hook claude` from the `tool_call` handler for `bash`, feed the Claude
  JSON shape, apply `updatedInput.command`. Alternative: `rtk hook check
<cmd>` dry-run. rtk output filters run inside `rtk <cmd>`, so nothing else
  is needed on the result side.
- format-on-edit: `hooks/atlas-core/format-on-edit.sh` reads Claude's stdin
  JSON and uses `tool_input.file_path`, cwd from `CLAUDE_PROJECT_DIR` or pwd.
  pi's write/edit input key is `path`. The generated `tool_execution_end`
  handler must translate to `{"tool_input":{"file_path": <abs path>}}` and set
  `CLAUDE_PROJECT_DIR` so the script stays byte-identical across targets.
- Command guard: no existing script; generate regexes from a codass-side
  list. Claude-side equivalents live in `~/.claude/settings.json`
  `permissions` (allow list; no deny list there today) and in memory rules,
  so the pi list is the first explicit one. Keep it short.

## 6. Open items for the final report

- Whether `.mcp.json` env defaults `${VAR:-x}` work in pi-mcp-adapter (4.3).
- Which context file pi actually loads in the atlas root (4.1), and whether
  the `.claude/rules` chain needs an `AGENTS.md` shim or the `claude-rules.ts`
  example.
- Any models.yaml `roles.pi` additions and their thinking mapping.
- Whether the linear filter proxy was kept for pi.
