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
    "/home/eugene/projects/pi-extensions/footer",
    "/home/eugene/projects/pi-extensions/background",
    "/home/eugene/projects/pi-extensions/handoff"
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
   [--append-system-prompt <tmpfile>] [--mcp-config <tmpfile>] "Task: <task>"
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
passes it to the child as pi-mcp-adapter's own config flag:

```
--mcp-config /tmp/pi-subagent-mcp-XXXX/mcp-<agent>.json
```

The flag is registered by pi-mcp-adapter, which the settings `packages` entry
loads in the child; the adapter reads it straight off `process.argv`. Because
the servers arrive as a config layer rather than a runtime registration, the
child gets them with their `directTools` honoured — a `directTools: true`
server is called as one direct tool instead of through the `mcp` proxy.

The file replaces the adapter's *global* layer (`~/.pi/agent/mcp.json`) and
merges with everything else, project layers last, so a name that also exists in
`.mcp.json` or `.pi/mcp.json` resolves to the project's definition. Do not set
`PI_MCP_CONFIG_MODE=exclusive`: it makes the adapter ignore the flag entirely
and keep only the real global file. The one thing a child with inline servers
loses is the user-global `~/.pi/agent/mcp.json` layer, which the file stands in
for.

The argv is built per spawn, so a grandchild never inherits its grandparent's
servers: nothing is put in the environment and nothing is forwarded.

A definition without a `lifecycle` is written as `lifecycle: "eager"`: a child
is short-lived and was handed the server because it needs it, so the adapter
connects it during startup instead of spawning it inside the first tool call.
An explicit `lifecycle` in the agent's `mcpServers` block wins.

Direct tools are built at startup from the adapter's metadata cache
(`~/.pi/agent/mcp-cache.json`, keyed by server name and definition hash). The
first child to run a given server definition has no cache entry yet, so that
run still goes through the `mcp` proxy and populates the cache; subsequent
children get the direct tools.

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

The built-in pads the stats line to exactly `width`, and `<used>/<window>
<pct>%` is longer than the `<pct>%/<window>` it replaces, so every returned line
goes through `fitToWidth`: the added columns come back out of the longest run of
spaces (the right-alignment padding, never below one space), and truncation is
the backstop. The TUI aborts the process on any line wider than the terminal.

Everything inside the factory is wrapped in try/catch, and so is `render` itself
— a rewrite that throws at render time returns the built-in's untouched lines.
A construction failure notifies once and calls `ctx.ui.setFooter(undefined)`, so
a broken footer degrades to pi's instead of breaking the TUI. `/footer` toggles between the two for
troubleshooting. The footer is installed only in TUI mode.

When the background extension is loaded and something is running, a third line
lists the running tasks (`2 background: bg1 just test | bg2 pnpm build`), read
from the list that extension publishes on `globalThis`.

The line rewriting lives in `footer/render.ts`, free of any pi import, so it can
be exercised without a terminal: `node --experimental-strip-types
footer/render.test.ts`.

## `sandbox/`

The security extension. OS-level sandboxing of the `bash` tool via
`@anthropic-ai/sandbox-runtime` (bubblewrap on Linux, sandbox-exec on macOS),
vendored from pi-mono `examples/extensions/sandbox/`, plus the guards that cover
what the jail does not: a deny list of dangerous commands, and the file tools,
which reach the filesystem directly.

Config is merged from `~/.pi/agent/extensions/sandbox.json` then
`<cwd>/.pi/sandbox.json` (project wins), on top of the extension defaults.

Four deliberate changes to the upstream file:

1. `DEFAULT_CONFIG.network` is `{}` instead of an npm/pypi/github allowlist.
   Leaving `network.allowedDomains` undefined is the only way to get an
   unrestricted network out of the runtime — an empty array means "deny all".
2. When `SandboxManager.initialize()` fails and no domain allowlist is
   configured, the sandbox stays enabled instead of being switched off. See
   below.
3. `filesystem.allowRead`, denied-access capture and `trace` — three additions
   the runtime does not have. See below.
4. The command guards, the `.env` and sandbox-path guards on the file tools,
   and the bash gate. See below.

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

### Guards

A `tool_call` handler covers what the bash jail cannot:

- **Commands.** `git push`, `git push --force`, `git stash`, `git -C`, `sudo`,
  and `rm -r` whose first operand is outside `/tmp`. A leading `rtk ` is
  stripped before matching, so a wrapper prefix cannot hide what runs.
- **`.env` writes.** The `write` and `edit` tools refuse a path whose basename
  starts with `.env`. Reads are not guarded.
- **Sandbox paths.** `read`/`write`/`edit`/`grep`/`find`/`ls` are answered from
  the very config the jail was built with: a write outside `allowWrite` or
  inside `denyWrite`, and a read under a `denyRead` entry that no `allowRead`
  or `allowWrite` entry exposes. Everything the jail leaves visible stays
  readable. A disabled sandbox has no policy, so this guard is off with it.

Each is a prompt, not a hard block: with a UI the user picks `Block` or
`Allow once`; without one (`--print`, `--mode json`) it blocks.

### Bash gate

`bash` is refused outright unless the sandbox is in force, so a session where
initialization never ran fails closed instead of falling back to pi's
unsandboxed bash. `PI_SANDBOX_OFF=1` in the environment is the explicit opt-out;
it is announced loudly once per session.

### Denied-access capture

Both enforcement points append one JSON line per refusal to
`~/.pi/agent/sandbox-denials.log`, written by the pi process, outside the jail:

- sandbox: `{ts, cwd, command, line}` for each stderr line of a failed command
  matching `Read-only file system`, `Permission denied`, `No such file or
  directory` or `Operation not permitted` (10 lines per command at most)
- guards: `{ts, cwd, tool, path, reason}` for each blocked file-tool call, and
  `{ts, cwd, tool, command, reason}` for a bash call the gate refused

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

The bash gate above uses the extension's own state; the marker is for other
extensions in the same process, which read `active` to tell a sandboxed session
from an unsandboxed one.

Beside an active marker it also publishes the wrap itself:

```ts
globalThis.__codassSandboxWrap = (command: string) => Promise<string>;
```

That is the very function the sandboxed bash runs its own commands through, so
an extension executing a command outside the bash tool — `background/` does —
gets byte-for-byte the same confinement instead of rebuilding the jail. It is
cleared whenever the marker turns inactive, so a reader that finds no wrap must
fail closed.

### `trace`

`"trace": true` in the config, or `PI_SANDBOX_TRACE=1` in the environment, wraps
every sandboxed command in `strace -f -e trace=file -e status=failed`. The trace
file is written under `/tmp` (writable and shared with the host), then appended
to the denial log as `{ts, cwd, command, trace: true, tracePath, lines}`, capped
at 200 lines, with a note in the tool result. Without `strace` on `PATH` the
session notifies once and runs untraced.

## `background/`

Three tools to run a shell command detached from the turn. `background_run`
starts it and returns at once with a task id and the path of the log its output
is appended to; `background_wait` returns when the command ends or when a given
marker appears in that log; `background_kill` stops it. There is no log pager —
the agent reads or greps the log file itself with its own tools.

A task that ends on its own sends a user message with its outcome and log path,
which starts a turn when the agent is idle; while it is busy the outcomes queue
and one message covers them all at `agent_settled`. A task the agent already
heard about — through `background_wait` or `background_kill` — wakes nobody.
Tasks belong to the session: `session_shutdown` kills whatever still runs, and
each command is spawned detached in its own process group so a kill reaches the
whole command tree. `/background` lists what runs.

A background command is confined exactly as the bash tool is: the wrap comes
from `globalThis.__codassSandboxWrap`, published by `sandbox/` beside its
activation marker, and is looked up per run — extensions load in an arbitrary
order, so `sandbox/` may publish after this one starts. No marker, an inactive
one, or no wrap and `background_run` refuses with the reason — it never falls
back to running unconfined.

The lifecycle lives in `background/machine.ts`, free of any pi or node-process
import, with everything that touches the outside world behind a host interface
(`background/host.ts`). Probes: `node --experimental-strip-types
background/machine.test.ts`, `background/sandbox.test.ts`,
`background/wrap.test.ts` (the last one spawns real processes), and
`sandbox/background-wrap.test.ts`, which runs a background command through the
real bwrap jail and expects a denied write to fail. That last one lives in
`sandbox/` for its `node_modules`, and skips unless bwrap is installed and the
pi package is resolvable from there.

## `handoff/`

`/handoff [focus note]` replaces compaction with a handoff: the current model
writes a forward-looking baton (goal, state, decisions, next, pointers; never a
narration of the conversation) from the current branch, the file is saved
beside the transcript, and a new session opens with it in context:

```
~/.pi/agent/sessions/<cwd>/<stamp>_<id>.jsonl          the session
~/.pi/agent/sessions/<cwd>/<stamp>_<id>.handoff.md     its handoff
```

The new session is linked to the old one through `parentSession`, so `/tree`
and `/resume` still reach the full transcript. The handoff is appended to the
new session as its first entry, a displayed custom message, so everything that
follows runs against it. The focus note steers what the handoff covers; it
is not a task for the new session.

The command returns at once and does its work in the background: pi's input
loop waits for a command handler, and inputs typed meanwhile would be held
back from extensions. A status line above the editor shows progress. Inputs typed while the
handoff is being written are captured for the new session, listed as
`Handoff → …`, and after the switch sent there in order, one turn each, with
slash-command expansion: `/handoff`, then `/skill:implement PIS-1`, runs
`implement` in the new conversation.

Typed while the agent is running, `/handoff` arms instead of interrupting: it
waits for the agent to settle, which includes follow-ups queued before the
command, so those still run in the old session. While armed only Alt+Enter
follow-ups are captured; Enter (steering) still goes to the running agent.

`/handoff` again, armed or writing, cancels: the generation is aborted and the
captured inputs go back into the editor ahead of any text already there. Esc
while armed does what it always does, aborts the agent, which counts as
settled, so the handoff then starts writing.

### Prompt file

The generation prompt is built in, but a skill or markdown file can replace it:

```json
// ~/.pi/agent/extensions/handoff.json (global) or <cwd>/.pi/handoff.json (project, wins)
{ "promptFile": ".code_assistant/skills/eugene/loop-handoff/SKILL.md" }
```

The path is absolute, `~`-prefixed, or relative to the project cwd, so one
global setting follows every worktree. YAML frontmatter is dropped and the
extension's own contract is appended (the focus note is about content, output
the markdown only). An unreadable file warns and falls back to the built-in
prompt. `/skill:handoff` is a different thing: the vendored mattpocock skill,
run by the agent itself.

The behaviour is `handoff/machine.ts`, a state machine over a `Host`
interface with no pi imports; `index.ts` builds the host from the extension
context. Both it and the pure helpers in `lib.ts` are tested with fakes:

```
node --experimental-strip-types --test handoff/machine.test.ts handoff/lib.test.ts
```

One invariant the tests pin: the switch to the new session fires
`session_shutdown` on the old one, and the captured inputs must survive it.

## `loop/`

Makes a pi session run a codass supervised loop by itself. Inert unless codass
spawned the session with the loop env — no command, no handler, no timer:

```
CODASS_LOOP    the loop's name
LOOP_SKILL     the tick skill, sent as /<skill>
HANDOFF_PATH   the baton file; the loop's codass cache dir is its parent
LOOP_CADENCE   an interval, 30s / 1m / 1h        (one of the two)
LOOP_SCHEDULE  a 5-field cron expression, local time
HANDOFF_AT     context tokens at which the generation hands over
MAX_ITERS      ticks after which the generation hands over
```

The session owns its clock: codass never injects a tick and never kills it to
cut over, it only restarts a dead process. Every five seconds the extension
compares the `.last-tick` stamp beside the baton against the cadence (measured
start to start) or the next cron window, and when a tick is due and the agent is
idle it sends `/<skill>` as a user message and stamps. Deleting the stamp is
still `tick-now`: an absent stamp reads as due at once. A cron loop with no
stamp anchors to its next window instead, so a Monday loop pinned on Wednesday
first runs on Monday.

Each agent run — one tick, however many tool rounds it takes — bumps
`.iter-<session id>`, the same per-generation counter codass's monitor reads and
counts the same way. Once the count reaches `MAX_ITERS` or context reaches
`HANDOFF_AT`, the extension asks the handoff extension — once — to hand off now
on `handoff:request`, with a focus note about the loop and `HANDOFF_PATH` as the
baton path. The successor conversation opens in the same process with the baton
first, gets its own machine, and counts against its own counter file while
ticking on the same clock. It also archives the baton it succeeded, as codass's
own baton consumer does, and drops its predecessor's counter file. A handoff run
that never reaches a successor — it failed, or was cancelled — is released after
two minutes: nothing outside this session would ever unstick it, so the loop
resumes ticking and asks again. The cutover decision stays here rather than in the
handoff extension's auto mode, because a threshold held there is not carried
into the successor, while the loop env is.

`loop/machine.ts` is the machine over a `LoopHost` interface with no pi imports;
`index.ts` builds the host from the extension context and owns the timer, which
starts in `session_start` and stops in `session_shutdown`. Nothing assumes a TUI.

```
node --experimental-strip-types --test loop/machine.test.ts loop/lib.test.ts
```
