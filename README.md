# pi-extensions

Hand-written [pi](https://github.com/badlogic/pi-mono) extensions used by the
codass `pi` deploy target. codass references these directories by absolute path
from a generated `.pi/settings.json`:

```json
{
  "packages": ["npm:pi-mcp-adapter"],
  "extensions": [
    "/home/eugene/projects/pi-extensions/subagents",
    "/home/eugene/projects/pi-extensions/sandbox"
  ]
}
```

Both directories carry their own `package.json` + `node_modules`; run
`npm install` in each after cloning.

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

## `sandbox/`

OS-level sandboxing of the `bash` tool via `@anthropic-ai/sandbox-runtime`
(bubblewrap on Linux, sandbox-exec on macOS). Vendored from pi-mono
`examples/extensions/sandbox/`.

Config is merged from `~/.pi/agent/extensions/sandbox.json` then
`<cwd>/.pi/sandbox.json` (project wins), on top of the extension defaults.

Two deliberate changes to the upstream file:

1. `DEFAULT_CONFIG.network` is `{}` instead of an npm/pypi/github allowlist.
   Leaving `network.allowedDomains` undefined is the only way to get an
   unrestricted network out of the runtime — an empty array means "deny all".
2. When `SandboxManager.initialize()` fails and no domain allowlist is
   configured, the sandbox stays enabled instead of being switched off. See
   below.

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
