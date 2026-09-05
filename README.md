# pi-extensions

Hand-written [pi](https://github.com/badlogic/pi-mono) extensions used by the
codass `pi` deploy target. codass references these directories by absolute path
from a generated `.pi/settings.json`:

```json
{
  "packages": ["npm:pi-mcp-adapter"],
  "extensions": [
    "/home/eugene/projects/pi-extensions/subagents",
    "/home/eugene/projects/pi-extensions/sandbox",
    "/home/eugene/projects/pi-extensions/footer"
  ]
}
```

`subagents/` and `sandbox/` carry their own `package.json` + `node_modules`;
run `npm install` in each after cloning. `footer/` has no dependencies of its
own.

## `subagents/`

Registers a `subagent` tool that delegates a task to a named agent running in a
separate `pi` process with its own context window, model and tool allowlist.
Derived from pi-mono `examples/extensions/subagent/`, minus its `/implement`,
`/scout-and-plan` and `/implement-and-review` presets.

### Agent files

Markdown with YAML frontmatter, discovered from:

- `<cwd>/.pi/agents/*.md` — project (nearest `.pi/agents` walking up from cwd)
- `~/.pi/agent/agents/*.md` — user

Project agents shadow user agents with the same `name`. Both scopes are always
searched; there is no `agentScope` parameter.

### Frontmatter contract

```yaml
name: builder
description: one line
tools: read, write, edit, bash, grep, find, ls, subagent   # comma-separated pi tool names; absent = all tools
model: openai-codex/gpt-5.6-terra                          # provider/id
thinking: high                                             # off|minimal|low|medium|high|xhigh|max
mcpServers:                                                # optional, Claude .mcp.json server shape, already resolved (no ${VAR})
  linear:
    command: uv
    args: [...]
    env: { LINEAR_API_TOKEN: "..." }
```

- `name` and `description` are required; a file missing either is skipped.
- `tools` also accepts a YAML list. Absent means the child gets every tool.
- `model` absent inherits the dispatching session's model; `thinking` absent
  inherits the dispatching session's thinking level only when `model` is also
  absent, so an agent that pins a model gets that model's default effort.
- `mcpServers` also accepts a list of single-key maps, which is how codass emits
  inline MCP servers.
- Everything after the frontmatter is the child's system prompt. It is written
  to a 0600 temp file and passed as `--append-system-prompt <file>`, matching
  the upstream example: the child keeps pi's own system prompt and the agent
  body is appended to it.

### Child invocation

```
pi --mode json -p --no-session -a \
   [--model <provider/id>] [--thinking <level>] [--tools a,b,c] \
   [--append-system-prompt <tmpfile>] "Task: <task>"
```

`-a` is what makes nesting work: the child trusts the same project
`.pi/settings.json`, so it loads this extension too and its own agents can spawn
further children. Verified to depth 2.

The child binary is resolved as pi's own entry script under the current runtime
(`process.execPath <argv[1]>`), falling back to `pi` on `PATH` and then to
`~/.local/share/pnpm/pi`.

### Modes

- single: `{ agent, task, cwd? }`
- parallel: `{ tasks: [{ agent, task, cwd? }] }` — max 8 tasks, 4 concurrent
- chain: `{ chain: [{ agent, task }] }` — `{previous}` in a task is replaced by
  the previous step's final output; the chain stops on the first failure

Each result carries the child's `model` and `thinking` in the tool `details` and
in its usage line, so a nested dispatch can be traced to the model that ran it.

Progress streams through `onUpdate`. Every returned text is capped at 50 KB;
the untruncated messages stay in the tool details. Aborting the tool (Ctrl+C)
sends SIGTERM to the children, then SIGKILL after 5s.

### Inline MCP servers

An agent's `mcpServers` never reach `.mcp.json` and never load in the parent
session. The parent writes `{"mcpServers": {...}}` to a 0600 temp file and
points the child at it with:

```
PI_SUBAGENT_MCP_CONFIG=/tmp/pi-subagent-mcp-XXXX/mcp-<agent>.json
```

The child reads that variable at `session_start` and hands each server to the
pi-mcp-adapter that settings `packages` already loaded:

```ts
import { registerMcpServer } from "pi-mcp-adapter";
registerMcpServer({ pi, name, definition });
```

Registrations are runtime-scoped and never persisted. `createMcpAdapter({ config })`
— a second adapter instance — cannot be used here: it re-registers the `mcp` and
`mcpScript` tools and the `--mcp-config` flag, and pi aborts the session with
`Tool "mcp" conflicts with .../subagents/index.ts`. This means the child must
have pi-mcp-adapter loaded from `packages`, which the settings above provide.

`pi-mcp-adapter` is a normal `dependencies` entry of this directory, so the
import resolves from `subagents/node_modules` — an extension cannot import the
copy `pi install` puts in `<agent dir>/npm/node_modules`.

A child that has no `mcpServers` gets the variable explicitly removed from its
environment, so a grandchild never inherits its grandparent's servers.

An inline server whose name the adapter already configures — from `.mcp.json`,
`.pi/mcp.json`, `~/.pi/agent/mcp.json` or any other adapter source — is skipped,
and the child logs one line to stderr (kept in the tool's `details.results[].stderr`):

```
subagents: inline MCP server "playwright" is already configured; keeping the configured one.
```

A definition without a `lifecycle` is registered as `lifecycle: "eager"`: a
child is short-lived and was handed the server because it needs it, so the
adapter connects it during startup instead of spawning it inside the first tool
call. An explicit `lifecycle` in the agent's `mcpServers` block wins.

`directTools` cannot be delivered this way. `registerMcpServer` in
pi-mcp-adapter 2.32.1 rewrites every runtime registration to
`directTools: false` — runtime servers are proxy-tool-only because direct tools
are frozen at startup — so an inline server is always reached through the `mcp`
proxy tool whatever its definition says. Direct tools would require handing the
child its servers through the adapter's own `--mcp-config` flag instead of
`PI_SUBAGENT_MCP_CONFIG`.

`registerMcpServer` throws `MCP server "<name>" is already registered` on a
duplicate name, so the check is what keeps the session clean. The configured
definition is the one the session would keep either way; the configured name
list comes from the adapter's own `loadMcpConfig()`, so it follows the adapter's
source precedence.

## `footer/`

pi's own footer, minus the extension-status line, with the context fragment
showing how much of the window is used rather than only a percentage:

```
6.2%/272k (auto)      →   17k/272k 6.2% (auto)
```

The built-in `FooterComponent` is a public export of
`@earendil-works/pi-coding-agent`, so the extension constructs it and
post-processes its `render(width)` output: keep the first two lines (pwd,
stats), rewrite the context fragment in the second. The rewrite matches the
visible text only, so the colour wrapper pi puts around a high-usage percentage
survives.

`FooterComponent` takes pi's internal `AgentSession`, which extensions cannot
reach. A shim exposes exactly the members it reads:

| member | source |
| --- | --- |
| `state.model` | `ctx.model` |
| `state.thinkingLevel` | `ctx.thinkingLevel` |
| `sessionManager` (`getEntries`, `getCwd`, `getSessionName`) | `ctx.sessionManager` |
| `getContextUsage()` | `ctx.getContextUsage()` |
| `modelRuntime.isUsingSubscription(provider)` | constant `false` — no public source |

The constant is the one visible difference: a subscription-backed provider with
no accrued cost shows no ` (sub)` marker. `state` is a getter, so a model or
thinking-level change is picked up on the next render.

Everything inside the factory is wrapped in try/catch: a failure notifies once
and calls `ctx.ui.setFooter(undefined)`, so a broken footer degrades to pi's
instead of breaking the TUI. `/footer` toggles between the two for
troubleshooting. The footer is installed only in TUI mode.

The line rewriting lives in `footer/render.ts`, free of any pi import, so it can
be exercised without a terminal: `node --experimental-strip-types
footer/render.test.ts`.

## `sandbox/`

OS-level sandboxing of the `bash` tool via `@anthropic-ai/sandbox-runtime`
(bubblewrap on Linux, sandbox-exec on macOS). Vendored from pi-mono
`examples/extensions/sandbox/`.

Config is merged from `~/.pi/agent/extensions/sandbox.json` then
`<cwd>/.pi/sandbox.json` (project wins), on top of the extension defaults.

Three deliberate changes to the upstream file:

1. `DEFAULT_CONFIG.network` is `{}` instead of an npm/pypi/github allowlist.
   Leaving `network.allowedDomains` undefined is the only way to get an
   unrestricted network out of the runtime — an empty array means "deny all".
2. When `SandboxManager.initialize()` fails and no domain allowlist is
   configured, the sandbox stays enabled instead of being switched off. See
   below.
3. `filesystem.allowRead`, denied-access capture and `trace` — three additions
   the runtime does not have. See below.

### Network and socat

`@anthropic-ai/sandbox-runtime` is deny-by-default for the network, and the
only "unrestricted" setting is no network config at all:

| `network` in config | effect |
| --- | --- |
| absent / `{}` | no network restriction; the sandbox keeps the host network namespace |
| `allowedDomains: []` | all network denied |
| `allowedDomains: [...]` | only those domains, through the runtime's HTTP/SOCKS proxies |

socat is only *used* by the proxy bridge, i.e. only when a domain allowlist is
set. It is nevertheless *checked for* unconditionally on Linux:
`SandboxManager.initialize()` calls `checkDependencies()`, which requires
`bwrap`, `rg` **and** `socat`, and `initialize()` also starts the socat bridge
before it knows whether any domain filtering is needed. On a host without socat
it therefore throws — but it stores the config before throwing, so
`wrapWithSandbox()` still produces a correct, fully restrictive bwrap command.
That is why change (2) above exists: with no allowlist, filesystem sandboxing is
complete and nothing that needs socat is ever built. Install socat if you want
domain filtering.

### bwrap deny-target handling

The runtime binds `/dev/null` over a fixed set of dangerous paths (`.git/config`,
`.claude/commands`, `.claude/agents`, `.vscode`, `.idea`, `.bashrc`, `.env`, …).
bwrap materialises a missing target as a read-only empty *file*, so in any
directory lacking some of those names the first run left 0-byte placeholders
behind — and a placeholder `.git` then broke every later run with `bwrap: Can't
mkdir parents for .../.git/hooks: Not a directory`.

`dropMissingDevNullBinds()` in `index.ts` strips every `--ro-bind /dev/null
<target>` (and `--bind` variant) whose target does not exist on the host before
the bwrap command is executed. Nothing is lost: there is no file to hide. Any
directory, including a bare scratch dir, is now safe to run in.

### `filesystem.allowRead`

`@anthropic-ai/sandbox-runtime` 0.0.26 has no `allowRead`: on Linux it turns
`denyRead` entries into `--tmpfs`/`--ro-bind /dev/null` mounts and offers no way
to punch a hole back. `allowRead` is therefore an extension-only key, applied by
rewriting the bwrap argv before the command runs.

```json
"filesystem": {
  "allowWrite": ["/home/me/projects/atlas", "/tmp"],
  "denyWrite": ["/home/me/projects/atlas/backend/.env"],
  "denyRead": ["~/"],
  "allowRead": ["~/projects", "~/.local", "~/.cache"]
}
```

That policy is what codass generates: outside the home directory everything
stays readable, because a build needs the system; inside it nothing is, beyond
the listed subtrees — so the credentials of software installed later are hidden
by default rather than after someone remembers to deny them.

bwrap applies mounts in argv order, and the runtime emits read denies last, so a
literal `--tmpfs ~` would bury the worktree bind that precedes it.
`applyAllowRead()` moves that tmpfs to the front of the filesystem mounts, binds
each existing `allowRead` path read-only right after it (parents before
children), and leaves the runtime's write binds and deny binds behind them,
where they still win.

The home directory itself is a writable tmpfs inside the jail: a command can
create `~/probe.txt`, but it lands in an empty overlay that disappears with the
command, not in the real home.

The `allowRead`/`allowWrite` lists codass writes are per-machine, from
`.code_assistant/config.yaml`:

```yaml
pi:
  sandbox:
    allow_read: [...]   # replaces codass' default list
    allow_write: [...]  # replaces codass' default list (worktree and /tmp stay)
```

### Denied-access capture

The same policy file is read by the codass-generated `codass-hooks.ts`, which
applies it to pi's `read`/`write`/`edit`/`grep`/`find`/`ls` tools — they reach
the filesystem directly, not through the sandboxed bash.

Both enforcement points append one JSON line per refusal to
`~/.pi/agent/sandbox-denials.log`, written by the pi process, outside the jail:

- sandbox: `{ts, cwd, command, line}` for each stderr line of a failed command
  matching `Read-only file system`, `Permission denied`, `No such file or
  directory` or `Operation not permitted` (10 lines per command at most)
- hooks: `{ts, cwd, tool, path, reason}` for each blocked file-tool call

A failed sandboxed command also carries a `<sandbox_hint>` block appended to its
tool result, listing those lines and pointing at the allow list, so the model
learns the path is outside the sandbox instead of retrying blind.

### Activation marker

The extension publishes a session marker on `globalThis` so another extension in
the same process can tell whether bash is really sandboxed:

```ts
globalThis.__codassSandbox = {
  active: true,
  config: { networkRestricted, allowRead, allowWrite, denyWrite, trace }, // counts
};
```

It is set from `session_start`, after the bash override is wired *and* the
sandbox is in force — never at import time. Every path that deliberately runs
unsandboxed publishes `{ active: false, reason }` instead: `--no-sandbox`,
`"enabled": false`, an unsupported platform, and a `SandboxManager.initialize()`
failure that is not the socat case. A load failure of this file leaves the
marker undefined.

The `codass-hooks.ts` extension codass generates depends on this: at each `bash`
`tool_call` it reads the marker and blocks the call unless `active` is true, so
a sandbox that never registered fails closed instead of falling back to pi's
built-in unsandboxed bash. `PI_SANDBOX_OFF=1` in the environment is the explicit
opt-out; the hooks extension notifies loudly once per session when it is used.

### `trace`

`"trace": true` in the config, or `PI_SANDBOX_TRACE=1` in the environment, wraps
every sandboxed command in `strace -f -e trace=file -e status=failed`. The trace
file is written under `/tmp` (writable and shared with the host), then appended
to the denial log as `{ts, cwd, command, trace: true, tracePath, lines}`, capped
at 200 lines, with a note in the tool result. Without `strace` on `PATH` the
session notifies once and runs untraced.
