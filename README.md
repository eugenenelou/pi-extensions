# pi-extensions

Hand-written [pi](https://github.com/badlogic/pi-mono) extensions used by the
codass `pi` deploy target. pi loads everything from one flat `packages` list in
`~/.pi/agent/settings.json` — bundled npm packages, local extension directories
and single extension files alike, by path:

```json
{
  "packages": [
    "/home/eugene/.local/share/pi/bundles/pi-mcp-adapter",
    "/home/eugene/.local/share/pi/bundles/pi-web-access",
    "/home/eugene/.local/share/pi/bundles/pi-vetter",
    "/home/eugene/projects/pi-extensions/background",
    "/home/eugene/projects/pi-extensions/footer",
    "/home/eugene/projects/pi-extensions/goal",
    "/home/eugene/projects/pi-extensions/handoff",
    "/home/eugene/projects/pi-extensions/loop",
    "/home/eugene/projects/pi-extensions/sandbox",
    "/home/eugene/projects/pi-extensions/subagents",
    "/home/eugene/projects/atlas/codass/codass_cli/targets/pi/codass-hooks.ts",
    "/home/eugene/projects/atlas/codass/codass_cli/targets/pi/codass-rules.ts"
  ]
}
```

That list belongs to the operator: `bootstrap.sh` puts the entries above in
place and nothing else rewrites it. The exception is the two codass entries,
which `codass deploy pi` adds and owns; bootstrap never touches them.
`codass-hooks.ts` runs the enabled packs' hook scripts on pi tool calls, fed
Claude's stdin shape, and keeps the session records codass reads to list and
resume pi sessions. `codass-rules.ts` gives pi the per-rule path scoping it has
no notion of: a deploy writes the glob-scoped rules — title, globs, absolute
path of the body — to a `codass-rules.json` manifest beside `APPEND_SYSTEM.md`,
which carries every other rule, and the extension appends a rule to the first
`read`, `edit` or `write` result inside the project whose path its globs match,
once per conversation.

pi-mcp-adapter is the operator's too: `codass deploy pi` no longer puts it in a
project's `.pi/settings.json` (it still does for a loop profile, which has its
own agent dir), and `codass doctor` warns when the user settings lack it.

## Bundled npm extensions

pi loads an npm extension as raw TypeScript, one file per module of its whole
dependency tree: pi-web-access alone opened ~1,000 files at every start.
`bundle.ts` (esbuild) turns each package in its `PACKAGES` list into one
tree-shaken file under `~/.local/share/pi/bundles/<name>/`, plus its skills and the
data files it reads next to its own modules. The packages are devDependencies
here; to update one, bump it, `pnpm install`, rebundle:

```
node --experimental-strip-types bundle.ts
```

Two constraints shape the output. pi serves its own API packages
(`@earendil-works/*`, `typebox`) as virtual modules of its loader, but only
for an import Node cannot resolve natively — so the bundles live outside this
repo, whose `node_modules` would otherwise supply a second copy of pi. And a
file that big must not go through pi's loader itself (it transpiles, seconds on
a cold cache), so each extension is a tiny ESM entry that imports the virtual
modules and hands them to a CommonJS body that Node loads natively.

`subagents/` and `sandbox/` carry their own `package.json`; they are pnpm
workspace packages, so one `pnpm install` at the root covers them and the root
itself. `footer/` has no dependencies of its own. `shared/` is not an
extension: it holds code more than one of them uses.

`pnpm check` typechecks every extension against pi's own declarations. pi loads
these files by stripping their types without checking them, so nothing else
compares what an extension calls against what pi exports: run it after touching
an extension, and after every pi version bump, where a renamed API surfaces as
a silent runtime failure.

## Bootstrap

A fresh laptop:

```
git clone <this repo>
pnpm install
./bootstrap.sh
codass deploy pi
```

`bootstrap.sh` owns the parts of `~/.pi` that are neither pi's own state nor
codass's output, and is safe to re-run:

- the bundles under `~/.local/share/pi/bundles` (built by `bundle.ts`), and
  `pi install` for each package above that is not already in `packages`
- `~/.pi/web-search.json` — `workflow: none`, `autoOpenBrowser: false` for
  pi-web-access (note the path: it is not under `~/.pi/agent`)
- `~/.pi/agent/extensions/permissions.json` — grants the sandbox's global layer
  `web_search`, `fetch_content`, `get_search_content`, `source_check`
- `~/.pi/agent/agents/researcher.md` — copied from `bootstrap/researcher.md`
- `~/.pi/agent/AGENTS.md` — the line routing web access through `researcher`

Every JSON write merges into the existing file, so operator keys survive.

## Config files

An extension config file lives at `extensions/<name>.json` under two roots,
read by `shared/config.ts`:

- `~/.pi/agent/extensions/<name>.json` — the agent dir, which for a codass loop
  is the rendered profile dir
- `<cwd>/.pi/extensions/<name>.json` — the project

One relative path for both layers, so a file declared once is right for a loop
profile and for a worktree. The helper only reads, and tells absent from
unparseable; each extension keeps its own merge rule — `sandbox.json`
deep-merges over the defaults and unions its allow lists, `permissions.json` unions and fails closed on an
unparseable file, `handoff.json` resolves each layer's `promptFile` against
that layer's own base, `judge.json` is last wins.

```
node --experimental-strip-types --test shared/config.test.ts shared/judge.test.ts
```

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
tools: read, write, edit, bash, grep, find, ls, subagent # comma-separated pi tool names; absent = all tools
model: openai-codex/gpt-5.6-terra # provider/id
thinking: high # off|minimal|low|medium|high|xhigh|max
mcpServers: # optional, Claude .mcp.json server shape, already resolved (no ${VAR})
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

The file replaces the adapter's _global_ layer (`~/.pi/agent/mcp.json`) and
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

| member                                                      | source                              |
| ----------------------------------------------------------- | ----------------------------------- |
| `state.model`                                               | `ctx.model`                         |
| `state.thinkingLevel`                                       | `ctx.thinkingLevel`                 |
| `sessionManager` (`getEntries`, `getCwd`, `getSessionName`) | `ctx.sessionManager`                |
| `getContextUsage()`                                         | `ctx.getContextUsage()`             |
| `modelRuntime.isUsingSubscription(provider)`                | constant `false` — no public source |

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

Config is merged from the two `extensions/sandbox.json` layers on top of the
extension defaults. The project layer wins per key, except `allowRead` and
`allowWrite`, which are the union of both: the agent-dir layer says which paths
under a hidden home hold this machine's toolchain, and a checkout must not be
able to take that away.

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

| `network` in config     | effect                                                               |
| ----------------------- | -------------------------------------------------------------------- |
| absent / `{}`           | no network restriction; the sandbox keeps the host network namespace |
| `allowedDomains: []`    | all network denied                                                   |
| `allowedDomains: [...]` | only those domains, through the runtime's HTTP/SOCKS proxies         |

socat is only _used_ by the proxy bridge, i.e. only when a domain allowlist is
set. It is nevertheless _checked for_ unconditionally on Linux:
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
bwrap materialises a missing target as a read-only empty _file_, so in any
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

The runtime's own launch files get the same treatment: its script runs
`apply-seccomp <filter>` inside the jail before the user command, and both files
live wherever `@anthropic-ai/sandbox-runtime` is installed — under home, for a
checkout like this one. `bootstrapAssets()` reads their paths off the generated
command and binds them read-only next to the `allowRead` paths. They are the
only files re-exposed without being in a policy; a `denyRead` that names their
directory still wins.

At `session_start`, `verifySandboxBootstrap()` runs one `true` through the
jail exactly as bash will. If it fails, the sandbox is refused — bash stays
blocked, never unconfined — and the notification names the launch file that is
missing on the machine or the `denyRead` entry hiding it.

A git worktree's `.git` is a pointer file, not a directory; a missing
protected path whose nearest existing ancestor is that file gets it frozen
read-only onto itself instead of masked with `/dev/null`, so git can still
read it. The main checkout's `.git` must be in `allowWrite` for git commands
to work from inside a worktree.

The home directory itself is a writable tmpfs inside the jail: a command can
create `~/probe.txt`, but it lands in an empty overlay that disappears with the
command, not in the real home.

The `allowRead`/`allowWrite` lists codass writes are per-machine, from
`.code_assistant/config.yaml`:

```yaml
pi:
  sandbox:
    allow_read: [...] # replaces codass' default list
    allow_write: [...] # replaces codass' default list (worktree and /tmp stay)
```

### Guards

A `tool_call` handler covers what the bash jail cannot:

- **Commands.** `git push`, `git push --force`, `git stash`, `git -C`, `sudo`,
  and `rm -r` whose first operand is outside `/tmp`. A leading `rtk ` is
  stripped before matching, so a wrapper prefix cannot hide what runs.
- **`.env` writes.** The `write` and `edit` tools refuse a path whose basename
  starts with `.env`. Reads are not guarded.
- **Sandbox paths.** Any tool call carrying a `path` is answered from
  the very config the jail was built with: a write outside `allowWrite` or
  inside `denyWrite`, and a read under a `denyRead` entry that no `allowRead`
  or folder grant exposes. On Linux, `allowWrite` only reopens reads through
  the home-directory overlay; other read denies remain hidden. Everything the
  jail leaves visible stays readable. A disabled sandbox has no policy, so
  this guard is off with it.

Command and `.env` guards prompt: with a UI the user picks `Block` or
`Allow once`; without one (`--print`, `--mode json`) they block. Sandbox-path
policy denials always block — a command approval cannot grant filesystem
access. Folder access is supplied as a policy grant, rather than by this
command-approval prompt.

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

It is set from `session_start`, after the bash override is wired _and_ the
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
real bwrap jail and expects a denied write to stay off the host. Those last two
live in `sandbox/` for its `node_modules` (pi is a devDependency there, so a
plain `pnpm install` satisfies them), and skip unless bwrap is installed.
`sandbox/hidden-home-jail.test.ts` is the other real-jail probe: the codass
policy (`denyRead: ["~/"]`, one worktree allowed) with the runtime's launch
files under that hidden home. The two real-jail probes share sandbox-runtime
state, so run them with `--test-concurrency=1`.

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

`/handoff-file [focus note]` uses the same branch, configured prompt, model,
and `<session>.handoff.md` path, overwriting that file without switching
sessions or adding anything to the conversation. It works without a TUI, does
not capture or replay input, and treats `auto …` as an ordinary focus note.
It is an ordinary command (`file.ts`, outside the machine): nothing to cancel,
and it neither interrupts a `/handoff` in progress nor holds one back. pi runs
a registered command at once, streaming or not — Alt+Enter cannot defer one, it
selects a queue commands never enter — so the wait is the command's own: typed
while the agent runs it shows `Handoff file: scheduled, writes when the agent
settles` on a status line of its own — that line is the whole signal, nothing
is notified until the file is there — then writes once the turn ends. A second
`/handoff-file` while one is in flight is refused, not queued.

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

`/tree` also cancels, on both `session_before_tree` and `session_tree`:
navigating moves the branch under the run without ending the session, and pi
aborts the running turn on its way there — which an armed run would otherwise
read as the agent settling and hand off on.

### Prompt file

The generation prompt is built in, but a skill or markdown file can replace it:

```json
// extensions/handoff.json, in the agent dir or in the project (which wins)
{ "promptFile": "docs/handoff-prompt.md" }
```

The path is absolute, `~`-prefixed, or relative to the config's own base — the
agent dir for the global config, the project cwd for the project one — so one
global setting follows every worktree. YAML frontmatter is dropped and the
extension's own contract is appended (the focus note is about content, output
the markdown only). An unreadable file warns and falls back to the built-in
prompt. `/skill:handoff` is a different thing: the vendored mattpocock skill,
run by the agent itself.

The behaviour is `handoff/machine.ts`, a state machine over a `Host`
interface with no pi imports; `index.ts` builds the host from the extension
context. Both it and the pure helpers in `lib.ts` are tested with fakes:

```
node --experimental-strip-types --test handoff/*.test.ts
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
LOOP_CADENCE   the interval in whole seconds     (one of the two)
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

## `goal/`

`/goal <condition>` works towards a condition until it is reached, mirroring
Claude Code's own `/goal`. The condition is stored in the session and starts a
turn as the directive. After every agent run — once, however many turns the run
took — the `judge` model (`extensions/judge.json`, the session's model when
none is set) reads the condition and the conversation and answers on
two lines:

```
VERDICT: met | not-yet | impossible
REASON: …
```

`not yet` sends the reason back as the next run's instruction, once the session
is idle again, so the session drives itself. `met` and `impossible` write the
verdict into the conversation and clear the goal. A judge that does not answer
one of the three — or that hangs past its timeout — leaves the goal armed rather
than ending it.

`/goal` alone reports the condition, the elapsed time, the number of evaluated
runs and the last reason; `/goal clear` drops it. Three runs in a row without a
tool call stop the self-driving with a warning — the goal stays set and the
next message the user types resumes it, since the agent talking to itself is
the shape a stalled goal takes.

While a goal is active it holds automatic handoff on at the handoff default
threshold through `handoff:auto`, with the goal as the baton's focus note and
the goal entry as the successor's seed. The handoff writes that entry into the
new session and, once the baton is in place as its first entry, sends the
directive that resumes the goal there. The hold is released when the session
shuts down and when a session starts with no goal in it, so a later goal-less
conversation is not left handing off with a stale focus. Resuming a session with
an active goal re-arms it too, with a fresh timer and run count, but without
starting a turn. The footer shows `goal: <condition>` beside the
automatic-handoff marker. Everything works headless: no dialog, no widget, and the machine never assumes a TUI.

`goal/machine.ts` is the machine over a `GoalHost` interface with no pi imports;
`index.ts` builds the host from the extension context.

```
node --experimental-strip-types --test goal/machine.test.ts goal/lib.test.ts
```
