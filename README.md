# Codex–OpenCode Bridge

An MCP bridge that lets Codex delegate bounded coding tasks to OpenCode while
keeping task state, prompts, events, and cancellation under bridge control.

> **Phase 7 status:** read-only Seatbelt isolation, filtered child environment,
> `agent_preflight`, `agent_delivery`, minimal context snapshots, provider
> pause/resume, and evidence-strength review prompts are implemented. The task
> inspection CLI, install/uninstall documentation, budgets, cleanup, approvals,
> daemon persistence, restart recovery, and the automatic local conversation
> viewer remain in place.

## What works now

- MCP stdio server (`@modelcontextprotocol/server` v2)
- Fifteen tools: `agent_viewer`, `agent_capabilities`, `agent_preflight`, `agent_spawn`, `agent_wait`, `agent_events`, `agent_status`, `agent_history`, `agent_message`, `agent_diff`, `agent_result`, `agent_delivery`, `agent_abort`, `agent_list`, `agent_cleanup`
- Automatic local live viewer for delegated tasks, exact recorded prompts, replies, and tool calls
- Policy/isolation discovery without a model call, preflight validation, bounded batch waiting, and compact task snapshots
- Verifiable delivery packages with base commit, patch hash, observed commands, actual model resolution, and explicit verification gaps
- macOS read-only Seatbelt isolation with a filtered child environment
- Per-task local model gateway: provider credentials stay in the bridge, while
  the sandboxed task gets a dummy key, isolated config, and localhost-only network
- Minimal hashed context snapshots for read-only tasks, with main-Agent-controlled expansion
- Provider auth/quota/region pause with a local `bridge resume` channel
- FIFO queue with configurable concurrency and queue limits
- Caller-controlled task duration: no automatic execution timeout by default;
  `agent_abort` stops queued/running tasks, while `agent_wait` and `agent_events`
  timeouts only end the wait
- Turn-scoped completion: a follow-up cannot complete from a previous turn's
  assistant, idle state, or replayed SSE event
- Turn usage is separated from cumulative session usage; live provider usage
  events update budget checks and emit 70%/90% threshold events
- Stable full-patch SHA-256 and complete/omitted file counts, unaffected by
  `max_chars`
- Immutable delivery snapshots survive worktree cleanup and later coordinator edits
- Optional `write_paths` contract for writable tasks, checked by OpenCode
  permissions and a post-run diff gate
- Bounded `workspace_from_task_id` reuse of a Bridge-owned worktree for a new
  read-only session
- Build SHA/config revision metadata and a compact `agent_result` entry point
- Explicit task state machine with verified cancellation
- Idempotency keys
- Structured, redacted event history with stable per-task sequence numbers
- Model allowlist and expensive-model authorization gate
- Fail-closed repository root policy
- Mock adapter for tests and protocol validation
- Real OpenCode 2.1 adapter:
  - private `opencode serve` process per task
  - version gate (`2.1.x` by default)
  - random Basic-auth password per server
  - isolated `OPENCODE_DB`
  - fail-closed permission config
  - session creation, prompt admission, SSE event collection, interrupt
  - usage/cost readback and assistant message capture
- Isolated Git worktrees for writable tasks, created from the recorded HEAD
- `agent_diff` for modified, added, deleted, and untracked files
- Session continuation through `agent_message`, using the same OpenCode session,
  workspace, model policy, and task lineage
- Edit-only writable mode under macOS `sandbox-exec` write confinement
- SQLite persistence for tasks, events, sessions, worktrees, and model usage
- Auto-started local daemon over a private Unix socket
- Task survival across MCP adapter restarts
- Safe restart recovery: unfinished tasks become `interrupted`, never re-run
- Token/cost budget enforcement with `BUDGET_EXCEEDED`
- Cleanup planning for worktrees and logs
- Persistent approval records for dirty-worktree deletion
- Independent local CLI approval channel (`bridge approve <id>`)
- Log retention and safe clean-worktree removal
- CLI task inspection:
  - `bridge preflight`
  - `bridge tasks`
  - `bridge status`
  - `bridge logs --follow`
  - `bridge diff`
  - `bridge delivery`
  - `bridge abort` / `bridge message`
  - `bridge resume`
  - `--json` output for scripting
- End-to-end mock acceptance script

## Requirements

- macOS (Apple Silicon tested) or Linux
- Node.js **24 LTS**
- pnpm 10+
- Git
- Codex CLI with MCP support (0.152.0 tested)
- OpenCode **2.1.x** for the real adapter (v2.1.2 tested)
- macOS for writable OpenCode tasks (`sandbox-exec`) and read-only OS read
  isolation; Linux read-only tasks fall back to OpenCode permissions unless an
  OS sandbox is added
- IPC clients reconnect before new requests after a daemon restart; in-flight requests
  fail without replaying mutations.
- Context-based follow-ups keep the same execution directory. Only newly authorized
  files are added; existing snapshots are never overwritten. Each turn retains its
  own hashed manifest. Start with context_files on the initial task to use this mode.
- The daemon starts automatically when the MCP server connects

Node 23 is EOL and is not supported. This machine has a keg-only Homebrew Node 24:

```bash
brew install node@24
export PATH="/opt/homebrew/opt/node@24/bin:$PATH"
node --version   # v24.x
```

## Install and build

```bash
PATH="/opt/homebrew/opt/node@24/bin:$PATH" pnpm install
PATH="/opt/homebrew/opt/node@24/bin:$PATH" pnpm typecheck
PATH="/opt/homebrew/opt/node@24/bin:$PATH" pnpm test
PATH="/opt/homebrew/opt/node@24/bin:$PATH" pnpm build
PATH="/opt/homebrew/opt/node@24/bin:$PATH" pnpm link --global
bridge daemon status
```

`pnpm link --global` installs the `bridge` CLI. Codex itself only needs the
absolute path to `dist/mcp/server.js`; the global link is for human inspection.

To uninstall the CLI:

```bash
bridge daemon stop
PATH="/opt/homebrew/opt/node@24/bin:$PATH" pnpm unlink --global codex-opencode-bridge
```

Review the data directory before deleting it:

```bash
rm -rf "$HOME/Library/Application Support/codex-opencode-bridge"   # macOS
```

## Configuration

Copy `examples/config.example.json` to
`~/.config/codex-opencode-bridge/config.json` and replace the sample allowed
root with a real absolute path.

```json
{
  "adapter": "mock",
  "models": {
    "default": "mock/echo",
    "allow": ["mock/echo"]
  },
  "security": {
    "allowed_repo_roots": ["/Users/you/Code"]
  }
}
```

- `adapter` can be `mock` or `opencode`.
- `security.allowed_repo_roots` is required. An empty list means every
  repository is rejected.
- `security.read_sandbox` defaults to `auto`: read-only OpenCode tasks use a
  macOS Seatbelt read profile when available. `require` rejects read-only tasks
  without OS read isolation; `off` keeps OpenCode permissions only.
- `security.model_gateway` defaults to `require`. Before starting a task, the
  bridge probes the selected provider, then runs the task through a localhost
  OpenAI-compatible gateway. The task process gets a dummy key, an isolated
  HOME/XDG tree, no user config/MCP servers, and network access only to that
  gateway. `auto` falls back to direct provider access for unsupported
  providers; `off` disables the gateway and restores direct access.
- `models.allow` accepts exact IDs and provider patterns such as `opencode-go/*`.
  OpenCode defaults to all Go models with `opencode-go/deepseek-v4.1-flash` as
  the default; explicit allowlists remain authoritative. Other providers require
  their own entries. A model not in the allowlist is rejected with
  `MODEL_NOT_ALLOWED`.
- Models listed in `models.expensive` require `models.allow_expensive: true`.
  The bridge never upgrades models automatically.
- `scheduler.max_concurrent` defaults to 2; `max_queue` defaults to 10.
- `scheduler.default_timeout_seconds` defaults to `0`, which means **no automatic
  execution timeout**. Set a positive value to give new tasks a default hard
  deadline, and set `timeout_seconds` per task when only some tasks need one.
  `scheduler.max_timeout_seconds` defaults to 604800 (7 days). The local caller
  stops a task through `agent_abort`; wait/event timeouts never stop execution.
  Existing configs that already set `default_timeout_seconds` keep that value.
- The OpenCode child environment is filtered. Only basic runtime variables and
  provider key prefixes are inherited; unrelated cloud, SSH, Git-host, and CI
  credentials are removed.

### Using the real OpenCode adapter

Copy `examples/config.opencode.example.json` and replace the sample model and
repository root. The model must be an exact `provider/model` pair exposed by
the installed OpenCode instance. Inspect the available models with:

```bash
opencode models
```

The bridge also queries `/api/model` after starting each private server and
rejects missing models with `MODEL_UNAVAILABLE`.

```json
{
  "adapter": "opencode",
  "models": {
    "default": "opencode/deepseek-v4.1-flash-free",
    "allow": ["opencode/deepseek-v4.1-flash-free"]
  },
  "security": {
    "allowed_repo_roots": ["/Users/you/Code"]
  },
  "opencode": {
    "binary": "/opt/homebrew/bin/opencode",
    "compatibility": "2.1.x",
    "startup_timeout_ms": 15000
  }
}
```

Read-only OpenCode tasks run with edit, shell, external-directory, web,
subagent, and question permissions denied. On macOS they also run under a
Seatbelt read profile by default: the user home, external mounts, and system
temp outside the task area are hidden from the process. In gateway mode the
task has an isolated HOME/XDG tree, no provider credentials, no user MCP
servers, and outbound network access only to a per-task localhost gateway. The
bridge's gateway process holds the upstream key and is the only component that
reaches the provider. Provider availability remains unverified until task
start.

Writable OpenCode tasks (`read_only: false`) require macOS and a Git repository.
The bridge creates a detached worktree under `data_dir/worktrees/`, starts
OpenCode in that worktree under `sandbox-exec`, and allows edit/write/patch.
Shell execution, external directories, web tools, subagents, and questions stay
denied. Uncommitted changes in the main worktree are reported, never copied.
On Linux or when `sandbox-exec` is unavailable, writable tasks fail with
`SANDBOX_UNAVAILABLE`; there is no permission-only fallback presented as a
sandbox.

The bridge stores an isolated OpenCode database and server logs under
`data_dir` (default: `~/Library/Application Support/codex-opencode-bridge` on
macOS, `~/.local/share/codex-opencode-bridge` on Linux). Set `data_dir` in the
config to override it.

Environment overrides: `BRIDGE_CONFIG`, `BRIDGE_ADAPTER`, `BRIDGE_MODEL`,
`BRIDGE_ALLOWED_ROOTS` (colon-separated), `BRIDGE_MAX_CONCURRENT`,
`BRIDGE_MAX_QUEUE`, `BRIDGE_DEFAULT_TIMEOUT_SECONDS`, `BRIDGE_LOG_LEVEL`,
`BRIDGE_MOCK_SCENARIO`, `BRIDGE_MOCK_DELAY_MS`.

## Daemon and storage

By default the MCP server connects to a long-lived local daemon. If no daemon is
running, the MCP server starts one in the background and waits for its socket.

Files are stored under `data_dir` (default
`~/Library/Application Support/codex-opencode-bridge` on macOS or
`~/.local/share/codex-opencode-bridge` on Linux):

- `bridge.sqlite` — tasks, events, sessions, worktrees, model usage
- `bridge.sock` — Unix socket, mode `0600` inside a `0700` directory
- `daemon.json` — daemon PID and socket metadata, mode `0600`
- `logs/daemon.log` — daemon log
- `tasks/<task-id>/` — per-task OpenCode database and sandbox files
- `worktrees/<task-id>/` — writable task worktrees

Closing Codex or the MCP adapter does not stop the daemon or running tasks.
If the daemon itself restarts, tasks that were queued/running are marked
`interrupted` with `SESSION_LOST`; they are never automatically re-executed.
Existing events, logs, and worktrees are retained for review.

For tests and development only, set `BRIDGE_INPROCESS=1` to run the task manager
inside the MCP process. That mode does not survive MCP exit and does not use the
daemon.

## Connect Codex

Build first, then register the server. Use the absolute Node 24 path so Codex
does not pick up Node 23 from `PATH`.

```bash
codex mcp add opencode_bridge \
  --env BRIDGE_CONFIG="$HOME/.config/codex-opencode-bridge/config.json" \
  -- /opt/homebrew/opt/node@24/bin/node \
  /absolute/path/to/codex-opencode-bridge/dist/mcp/server.js
```

Or add this to `~/.codex/config.toml`:

```toml
[mcp_servers.opencode_bridge]
command = "/opt/homebrew/opt/node@24/bin/node"
args = ["/absolute/path/to/codex-opencode-bridge/dist/mcp/server.js"]
startup_timeout_sec = 20
tool_timeout_sec = 60

[mcp_servers.opencode_bridge.env]
BRIDGE_CONFIG = "/Users/you/.config/codex-opencode-bridge/config.json"
```

Verify registration:

```bash
codex mcp list
```

## Tools

### Live conversation viewer / `agent_viewer`

Keep one viewer in the Codex in-app browser. Spawn and follow-up results include
`viewer_url` and `viewer_action`. `reuse_existing` means an authenticated viewer
has polled recently: do not open another tab. `open_if_missing` means inspect
existing tabs for the same URL first, and use `open_in_codex` only when none
exists. A heartbeat expires after 90 seconds; a sleeping tab may still exist.
After a daemon URL change, navigate the existing Bridge tab to the new URL.
`agent_viewer` exposes the same hint as `presentation`, plus `connected` and
`last_seen_at`. The daemon never opens a browser. The viewer follows new tasks and follow-up turns, shows the latest
100 turns grouped into conversations by root task, and polls the existing audit
records every second (every five seconds while its tab is in the background).
Inactive conversations use gray text and completed dots; conversations with an
active turn keep their normal emphasis. All active conversations remain visible;
only the latest five inactive conversations appear by default, with older ones
under **更早的历史会话**.
The transcript uses a chat layout: Codex delegation and follow-up instructions
appear on the right, OpenCode replies on the left, and tool activity is shown as
collapsible cards. The interface follows a monochrome Vercel/Geist-style visual
system with light and dark modes. Multi-turn work stays in one conversation, so
a follow-up turn does not replace the earlier context. Replies appear after OpenCode's
message readback completes; token-by-token reply streaming is not implemented.
Conversation messages display in full by default. Bash output opens automatically
and reveals another segment (up to 80 lines / 6000 characters) per **展开下一段**
click. Output expansion survives polling. New conversation and tool events retain
their full redacted text; ordinary audit metadata still has size limits. Previously
truncated records and output truncated upstream cannot be recovered. Expand the
actual prompt or enable **全部审计事件** to inspect system events.
Both sides render CommonMark/GFM headings, tables, nested and task lists,
quotes, links, emphasis, and fenced code. Wide tables scroll horizontally;
code blocks retain all content and offer a language label and copy button.
Raw HTML stays literal text, and images appear as links without automatic loading.
The Markdown parser is bundled locally, with no CDN or browser network dependency.

An already-polling viewer follows new tasks without opening duplicate tabs.
Selecting an older task pauses automatic following; re-enable **自动跟随**
to follow again. `agent_viewer` returns the private URL without a model call;
Codex uses `open_in_codex` to show it beside the chat. Automatic in-app opening
requires a host with this tool and the coordinating agent following the MCP
instructions; a standalone MCP daemon cannot open a Codex panel itself.

```bash
bridge viewer          # print the private URL; never launch a system browser
bridge viewer --json   # get its private local URL without opening a browser
```

The **配置** button opens local settings: view the credential source, change the
default model within the existing allowlist, or optionally set/remove an independent
Go API key. Saves apply to new tasks without restarting. Existing keys are never
returned to the page. Config writes require the private capability plus same-origin
JSON requests and use atomic replacement with mode 0600. Keep the private viewer
URL secret: it also authorizes these narrowly scoped settings changes.

Go normally reuses the active official OpenCode Console credential. A trusted
read-only catalog probe uses the user database so subscription models are visible;
only the parent reads the active credential and supplies authentication/workspace
headers to the official Go endpoint. Task workers keep isolated databases and
receive only a local gateway URL and dummy key. The parent never refreshes tokens
itself; reconnect in OpenCode when the login expires. OpenCode database schema
changes fail closed. `opencode.go_api_key` is an optional independent override.
The credential lookup follows the upstream [credential schema](https://github.com/anomalyco/opencode/blob/dev/packages/core/src/credential/sql.ts)
and [Console authentication implementation](https://github.com/anomalyco/opencode/blob/dev/packages/core/src/plugin/provider/opencode.ts).

The daemon owns the viewer, so it continues updating after an MCP adapter
disconnect. It binds only to `127.0.0.1` on an ephemeral port and serves no command endpoints. Only the validated settings route can write
the Bridge config; transcript endpoints are read-only. API requests require a random read-only capability from
the URL fragment, checked in an Authorization header. Host/Origin checks, a
same-origin CSP and plain-text rendering protect the log display. Keep its URL
private. Daemon restart rotates the port/key; retrieve the new URL with `bridge viewer`.

Local config controls:

```json
{ "viewer": { "enabled": true, "auto_open": false } }
```

`enabled` defaults to true. Legacy `auto_open` settings are accepted but ignored
(normalized to false), including old configurations with true. In-process test
mode does not start a viewer. `bridge viewer` only prints its URL.

### `agent_capabilities`

Call with `{}` before delegating. Reads the **daemon's** effective model policy,
default model, scheduler limits, soft budgets, and execution restrictions. Each
configured model has a `permitted` flag and an error code when policy blocks it.
This does not start OpenCode, query provider quotas, or invoke a model. Model
availability is validated at task start; allowlisting alone does not prove an
ID exists upstream. Mock capabilities and results are explicitly simulated.
`provider_paused` is populated after a provider auth/quota/region error and
blocks new delegations until the local `bridge resume` command clears it.

The response also discloses OS read isolation, the local model gateway mode
(`gateway`, `gateway_configured`, or `partial`), per-file scope enforcement,
independent verification of OpenCode's internal model calls, whether a default
execution deadline is active, and the running daemon's `build` metadata
(`version`, `git_sha`, `dirty`, `built_at`, `config_path`, `config_revision`).
Do not delegate writable work if your task requires boundaries the bridge does
not enforce. In that case Codex should implement the changes directly.

### `agent_preflight`

Call with the same repository root, model, and `read_only` mode you plan to use.
The daemon validates the path against `security.allowed_repo_roots`, resolves
the real Git top level and recorded `HEAD`, checks model policy, and returns:

- the actual repository root, Git top level, base commit, and main-worktree
  dirty files
- whether the workspace is the repository root or an isolated worktree to be
  created at task start, plus the planned worktree parent
- effective read/glob/grep/edit/write/patch permissions and denied shell, web,
  external-directory, subagent, and question capabilities
- `path_policy` with declared `read_paths`/`write_paths`, protected defaults, and
  whether per-file scope is actually enforced
- actual OS read/write isolation, model gateway mode, and the
  provider-network/credential exceptions
- a planned context snapshot with per-file SHA-256 and total bytes when
  `context_files` is supplied
- `workspace.kind: "managed_workspace"` and its path when
  `workspace_from_task_id` references a completed Bridge-owned worktree
- soft budgets, hard limits, default/max timeout, warnings, and an explicit
  `unverified` list

It does not create a task, start OpenCode, or call a model. A directory outside
the allowlist, a disallowed model, or a missing Git base fails here instead of
failing after a task has been queued.

### `agent_spawn`

Creates and enqueues a task. Returns a task ID immediately. `read_only` defaults
to **true**; writable work requires an explicit `false`. Provide a goal, exact
file scope, constraints, acceptance criteria, and a short expected report.

```json
{
  "task": "Inspect the parser and summarize its edge cases. Do not modify files.",
  "repo_root": "/Users/you/Code/example",
  "task_type": "analysis",
  "model": "provider/model",
  "read_only": true,
  "idempotency_key": "parser-edge-cases",
  "context_files": ["src/parser.ts", "package.json"]
}
```

`timeout_seconds` is optional and no automatic execution timeout is applied by
default. Set a positive value only when you want a hard deadline; `0` explicitly
disables it. Large tasks can keep running until you call `agent_abort`, and the
bridge verifies cancellation instead of silently abandoning the worker.

For writable tasks, pass `write_paths` (repository-relative files, or directories
ending in `/`). The bridge adds OpenCode edit rules for those paths and fails the
task with `SCOPE_VIOLATION` if the final diff touches anything else; the worktree
is preserved for review. Omitting `write_paths` keeps the older whole-worktree
behavior and preflight says so explicitly. `read_paths` is a declared review
scope; it does not prevent reads needed for dependencies.

For a new read-only session on a completed Bridge worktree/snapshot, pass
`workspace_from_task_id` plus the original `repo_root`. The bridge verifies the
source task, repository, and managed path; it never opens the whole data
directory or Library. Writable continuation still uses `agent_message` on the
original lineage.

For the OpenCode adapter, set `read_only: false` only when you want an isolated
worktree and are on macOS with `sandbox-exec`. Writable tasks are edit-only;
Codex remains responsible for running tests and merging.

Read-only tasks can pass `context_files` (repository-relative paths). The bridge
validates and hashes them, rejects traversal, and runs OpenCode in a task-local
workspace containing only those files. Limits are 100 files, 2 MiB per file, and
8 MiB total. Dependencies are not resolved automatically; a missing dependency
should be reported by the worker, and the main Agent can add it with
`agent_message.context_files`.

### `agent_wait`

```json
{ "task_ids": ["task_a", "task_b"], "timeout_seconds": 30 }
```

Waits for **any** of 1–8 tasks to become terminal or `waiting_permission`.
Returns `tasks`, `ready_task_ids`, `timed_out`, and `waited_ms`. Duplicate IDs
are collapsed; an unknown ID fails the whole request immediately. The default
wait is 30 seconds, maximum 50, below the example MCP tool timeout of 60 seconds.
Use `timeout_seconds: 0` for an immediate snapshot. A wait timeout leaves the
tasks running; only `agent_abort` requests cancellation. Remove ready IDs before
waiting again, because an already-finished task returns immediately.

Waiting happens inside the daemon and does not call a model or repeatedly send
status tool results to Codex. Pending waits end on IPC disconnect; the delegated
tasks continue. Task execution deadlines are optional and come from
`agent_spawn`; omitted or `0` means no automatic timeout.

### `agent_events`

Long-polls one task for incremental events after a sequence cursor:

```json
{ "task_id": "task_a", "after": 42, "timeout_seconds": 30, "limit": 100 }
```

Returns `events`, `next_after`, `timed_out`, `task_terminal`, and `waited_ms`.
It returns as soon as new events exist, or immediately when the task is terminal
with no remaining events. A timeout does not stop the task. Use `next_after` for
the next call. This avoids repeatedly transferring old event pages.

### `agent_status`

Returns a compact snapshot with status, stage, model, session, duration, total
tokens, estimated cost, error, result summary, and last event. It never calls a
model. `agent_status`, `agent_wait`, and `agent_list` default to `detail:
"summary"`: result summaries are capped at 2000 characters and explicitly marked
with `result_summary_truncated` and `result_summary_chars` when shortened. Use
`detail: "full"` to retrieve the complete stored summary, usage breakdown, and
all status fields. CLI/SQLite data remains unchanged.

### `agent_history`

Returns the delegated task text, the exact prompt sent to the adapter, agent
messages, tool events, shell events, and Bridge/OpenCode server events. Supports
`limit`, numeric `cursor` for older pages, forward `after` sequence, and
`event_types`. Use `after` for incremental inspection instead of repeatedly
fetching old events. Each turn's history contains only messages emitted for that
turn; previous assistant replies are not replayed into a follow-up. The task
header omits the original instruction text by default (`task_text_omitted:
true`); pass `include_task: true` to include it. Recorded prompt events remain
available. Payloads are redacted and truncated according to the configured
history limits. Conversation messages (`opencode.message`) use
`history.max_delegation_chars` rather than the smaller audit payload limit, so
assistant replies remain readable in the viewer.

For the real adapter, tool and shell records come from OpenCode SSE events;
assistant messages are read back from the session API. If the event stream
disconnects, the bridge records the disconnection and falls back to polling
session state.

### `agent_message`

Continues a completed task in its existing OpenCode session and workspace.
The bridge re-validates the model policy and lineage, then creates a **new turn
task** linked to the original. The new task has its own task ID, `parent_task_id`,
`root_task_id`, and `turn`, but reuses the same `session_id` and worktree.
Messages are serialized: if any task in the lineage is still active, the call
returns `TASK_BUSY`.

For a read-only task that used `context_files`, pass `context_files` to add
files. The bridge creates a new context snapshot for the turn; the worker cannot
expand its own access. A follow-up completes only after a new assistant message
for the current turn exists; a previous reply or stale idle event is not treated
as completion. `usage` on the new turn is incremental, while `session_usage` in
delivery/history reports the cumulative session total.

### `agent_diff`

Returns the task worktree's Git status, modified/added/deleted/untracked files,
line counts, and a patch. Use `file` to inspect one path and `max_chars` to limit
the displayed patch. `full_patch_sha256`, `full_patch_bytes`,
`complete_file_count`, `returned_file_count`, `omitted_files`,
`full_patch_complete`, and `truncation_reason` describe completeness;
`max_chars` never changes the full hash. Worktrees are retained after completion or failure for review. If a
worktree was removed, this returns `available: false` with
`reason: "workspace_removed"`; use `agent_delivery` for the frozen snapshot.

### `agent_result`

A compact, current-turn entry point. Returns the task status, final reply,
structured findings, model resolution, turn/session usage, budget and artifact
flags, changed-file list, stable patch SHA-256, observed commands, policy
snapshot, runtime versions, and verification gaps. It never includes patch text; call
`agent_delivery` when the full patch is needed. This avoids fetching status,
history, diff and delivery separately just to read the final answer.

### `agent_delivery`

Returns a reviewable delivery package instead of a bare "completed" claim. A
snapshot is frozen immediately after the worker stops (`git.source:
"snapshot"`), so later coordinator edits and worktree cleanup do not change the
recorded base commit, changed files, full patch bytes, or stable
`patch_sha256`. Legacy tasks without a snapshot use a live diff
(`git.source: "live"`); a removed worktree returns
`available: false, reason: "workspace_removed"` instead of a create-worktree
error. `max_chars` only changes the displayed patch; `patch_sha256` is always
computed over the full patch. `include_patch: false` returns metadata and hashes
without patch text.
The package also includes observed shell/tool commands and exit codes, the
actually resolved model when an `opencode.model.resolved` event exists,
the local gateway flag, context manifest, `usage` for this turn,
`session_usage` for the whole session (with explicit scopes), the policy snapshot
recorded at task creation, runtime versions (`bridge_version`,
`bridge_git_sha`, `opencode_version`, `config_revision`), budget/artifact flags,
and a verification status. `git.full_patch_complete: false` means the full hash
covers only the bounded untracked-file subset (currently 200 files); display
omissions are listed in `omitted_files`.
Review/analysis tasks are prompted to end with a fenced JSON findings block;
`delivery.findings` contains the parsed `location`, `trigger`, `evidence`, and
`confidence` values, and `verified: false` when the block is missing, malformed,
or truncated. The bridge does not execute tests or commands; those fields are
marked `unverified`, `tests_run_by_bridge: false`, and
`verified_by_bridge: false`. Mock commands are labelled `simulated`. This tool is
read-only and does not modify the worktree.

### `agent_abort`

The caller-controlled stop path. Cancels a queued task immediately. For a
running task it asks OpenCode to interrupt the session, waits for a terminal
state, and stops the private server process group if needed. This is the default
way to end a long-running task because task execution has no automatic timeout
unless `timeout_seconds` was set. Work already produced is preserved by design.

### `agent_list`

Lists current and historical tasks, newest first, with optional status, repo,
and model filters. Defaults to compact snapshots; use `detail: "full"` for all
status fields. `total` is the number returned, not a count of all stored tasks.

## Observe a task

```text
1. agent_capabilities to inspect model policy and isolation limits.
2. agent_preflight with the exact repo_root, model, and read_only mode; fix path,
   Git, sandbox, or model-policy errors before queueing work.
3. agent_list with project/status filters to check for existing work.
4. agent_spawn for a bounded task worth the handoff cost; use an idempotency key.
5. agent_wait on the returned task ID(s); use agent_events with an after cursor for
   incremental activity while continuing independent Codex work between waits.
   The Codex in-app viewer shows the task's conversation and tool activity.
6. agent_result for the current turn's final reply and stable metadata;
   agent_history (incremental after sequence), agent_diff, and agent_delivery to
   review actual activity, changes, patch hash, observed commands, and
   verification gaps.
7. Run relevant tests yourself and integrate only reviewed changes.
8. If needed, agent_message continues the session; wait on its NEW turn task ID.
9. agent_cleanup dry-run to inspect retained resources after integration.
```

Mock events are explicitly mock-labelled. Real OpenCode events are obtained from
the session API and SSE stream; no execution summary is synthesized as if it
were a tool record.

Small tasks and complex design/debugging stay with Codex. Worker text is
untrusted task data: it cannot authorize wider scope, model upgrades, or cleanup.
On account, balance, quota, rate-limit, authentication, or region errors, stop
delegating and ask the user to resolve the restriction. Never switch providers
or models to work around it. These are coordination instructions, not a new
daemon-wide account lockout mechanism.

**Upgrade compatibility:** clients relying on all fields from MCP status/list
must request `detail: "full"`; clients reading `history.task.task` must request
`include_task: true`. After updating and building, let active tasks finish, stop
the old daemon with `bridge daemon stop`, and reconnect/restart the MCP server.
An already-running daemon and MCP connection keep their loaded code; rebuilding
does not hot-reload them. The bridge does not stop existing tasks automatically
as part of this update.

## CLI

All commands use the local daemon and print human-readable output by default.
Add `--json` for scripting.

```bash
bridge tasks --status running --limit 20
bridge preflight /Users/you/Code/example --json
bridge preflight /Users/you/Code/example --writable --model opencode/deepseek-v4.1-flash-free
bridge viewer
bridge tasks --repo /Users/you/Code/example --json
bridge status <task-id>
bridge logs <task-id>
bridge logs --follow <task-id>
bridge logs <task-id> --types tool.called,tool.completed
bridge diff <task-id>
bridge diff <task-id> --file src/parser.ts --max-chars 20000
bridge delivery <task-id>
bridge abort <task-id>
bridge message <task-id> "Please add the missing edge-case assertion."
```

`bridge logs --follow` polls the daemon and prints new events until Ctrl-C.
`bridge diff` shows the worktree file summary and patch; large patches are
truncated unless a larger `--max-chars` is supplied. `bridge delivery` returns
the same verifiable package as `agent_delivery`.

## Budgets and cleanup

`models.max_tokens` and `models.max_cost_usd` are soft budgets. Usage events are
checked while a task runs; exceeding a limit requests cancellation and records
`BUDGET_EXCEEDED`. Cost enforcement requires the provider to report a known cost.
Queue size and concurrency are hard limits. Task timeouts are optional hard
deadlines when configured; `0` disables them. Preflight reports which limits are
hard and which are soft.

Provider authentication, account/quota, and region errors set a daemon-wide
pause: new spawns, messages, and preflights fail with `PROVIDER_PAUSED`. The
bridge never switches providers or models to work around the restriction.
Resolve the account issue, then clear the pause locally:

```bash
bridge resume
```

The pause is process-local; restarting the daemon also clears it.

`agent_cleanup` plans cleanup by default (`dry_run: true`). With `dry_run: false`
it:

- removes **clean** worktrees for completed tasks, subject to
  `cleanup.worktree_retention_days` unless task IDs are explicitly supplied
- deletes `logs/opencode-*.log` older than `cleanup.log_retention_days`
- creates a persistent approval for any **dirty** worktree instead of deleting it

Approvals are executed only through the local CLI:

```bash
bridge cleanup                 # dry-run plan
bridge cleanup --apply         # safe cleanup; dirty worktrees become approvals
bridge approve <approval-id>   # user-only destructive action
bridge resume                  # clear a provider/account pause
bridge daemon status
bridge daemon stop
```

Before an approved dirty worktree is force-removed, the bridge saves its patch
under `data_dir/approvals/<approval-id>.patch`. An MCP tool call alone can never
consume an approval.

## Security boundaries in Phase 7

- Only paths under `security.allowed_repo_roots` are accepted.
- Read-only OpenCode tasks use a macOS Seatbelt read profile by default. The
  user home, external mounts, and system temp outside the task area are hidden
  from the process. `security.read_sandbox: "require"` fails closed on hosts
  without it.
- In model-gateway mode, the task gets a dummy provider key, an isolated
  HOME/XDG tree, and no user MCP/plugin configuration. Outbound network is
  limited to the per-task localhost gateway. The bridge process holds the
  upstream key and forwards only `/v1/*` to the selected provider.
- The child environment is filtered: unrelated cloud, SSH, Git-host, and CI
  credentials are not inherited. Provider key prefixes are retained only when
  the gateway is off.
- Writable OpenCode tasks are enabled only on macOS with `sandbox-exec`.
- Writable tasks use a detached Git worktree; uncommitted main-tree changes are
  not carried into the worktree.
- Writable sessions are edit-only: shell, external directory, web, subagent,
  and question permissions are denied.
- The Seatbelt profile confines writes to the worktree, its task-local Git
  metadata, task data/temp directories, and OpenCode's own state/cache/log
  directories. OpenCode snapshots are disabled, and the main repository's Git
  object store is not writable. In gateway mode the write profile also denies
  user-home/external file data, allowing only the worktree, Git metadata, task
  data, and isolated config tree.
- The model allowlist is default-deny.
- Expensive models require a local configuration change; a task cannot grant
  itself permission.
- A private OpenCode server binds to `127.0.0.1`, uses a random Basic-auth
  password, and is killed as a process group after the task.
- History payloads redact common secret keys and reject full process
  environments. This is not a substitute for a filesystem sandbox.
- The daemon socket is accessible only to the current user through directory and
  socket permissions (`0700` / `0600`).
- Dirty worktrees require an approval created by the daemon and consumed by the
  local `bridge approve` CLI, not by Codex.
- MCP logs go to stderr. stdout is reserved for the JSON-RPC protocol.

**Known limitations:** the model gateway supports OpenAI-compatible provider
packages. `security.model_gateway: "require"` fails closed for other providers;
`auto` falls back to direct provider access and is reported as
`gateway_configured` rather than fully isolated. The short-lived provider probe
runs before the sandbox so it can read provider settings; it receives no task
prompt, has MCP and plugins disabled, and does not call a model. On macOS, the
read profile is still a denylist overlay rather than a complete filesystem
whitelist. On Linux, read-only tasks
rely on OpenCode permissions unless OS read isolation is added. When the gateway
is off or falls back to direct access, writable tasks use the broader write
profile and can read more of the host. Writable tasks are edit-only, so OpenCode
cannot run tests. `write_paths` is checked against the final diff, not enforced
mid-turn; omitting it allows edits anywhere in the isolated worktree.
`read_paths` is declared scope only. Worktrees and logs
are retained by default; `agent_cleanup` and the local approval CLI remove safe
resources, while dirty worktrees require user approval. The main repository's
Git object store is deliberately not writable from the sandbox. Tasks now survive MCP
adapter exits through the daemon, but a daemon crash cannot resume an in-flight
OpenCode turn; those tasks are marked interrupted and preserved for review.
With no automatic timeout, a stuck task keeps its concurrency slot until the
caller invokes `agent_abort`, the daemon shuts down, or the adapter process exits.

## Tests and acceptance

```bash
PATH="/opt/homebrew/opt/node@24/bin:$PATH" pnpm test
```

The default suite covers state transitions, queues,
model/path policies, redaction, event pagination, task lifecycle, idempotency,
timeouts, abort verification, MCP stdio, OpenCode HTTP/SSE, managed process
startup, worktrees, diffs, session continuation, SQLite persistence, daemon
IPC/reconnect, restart recovery, budgets, cleanup approvals, CLI approval and
inspection, Seatbelt read/write confinement, filtered child environments,
preflight validation, delivery packages, minimal context snapshots, provider
pause/resume, and fake OpenCode adapter lifecycles.
It also checks capability policy reporting, batch wait completion/deadlines,
permission wakeups, incremental event long-polling, input bounds, read-only
defaults, compact/full results, and incremental history headers through MCP and
daemon IPC. New regression coverage includes follow-up inbox/stale-idle
completion, turn-scoped usage, 70%/90% budget thresholds, final-step budget
handling, stable full-patch hashes across display limits, immutable delivery
snapshots after worktree cleanup and coordinator edits, 21-untracked-file
omission reporting and full-hash completeness, `write_paths` scope violations,
managed-workspace reuse, build/config metadata, historical budget snapshots, and
`agent_result`/metadata-only delivery.
All default tests are free.

A live OpenCode smoke test is opt-in and makes **no model call** (it admits a
prompt with `resume: false`):

```bash
OPENCODE_LIVE=1 PATH="/opt/homebrew/opt/node@24/bin:$PATH" pnpm test
```

It starts a real private OpenCode 2.1 server under the Seatbelt sandbox, checks
the version and models, creates a session, admits a no-reply prompt, and observes
`server.connected`. The live test passed against OpenCode 2.1.2 on this machine.

Run the full acceptance suite (typecheck, tests, build, MCP + daemon mock
lifecycle):

```bash
pnpm acceptance
OPENCODE_LIVE=1 pnpm acceptance   # also runs the no-model live smoke
```

The mock acceptance script exercises MCP -> daemon -> SQLite -> mock adapter,
task spawn, status, history, follow-up turn, diff, cleanup planning, and task
listing without spending model credits.

## Roadmap

| Phase | Scope |
|---|---|
| 2 | **Done:** real OpenCode adapter, private server, SSE, abort, model discovery, usage readback |
| 3 | **Done:** Git worktrees, diff inspection, macOS Seatbelt write confinement, edit-only writable tasks |
| 4 | **Done:** SQLite, daemon, Unix socket IPC, queue persistence, restart recovery, usage records |
| 5 | **Done:** budgets, log retention, cleanup plans, independent CLI approval for dirty worktrees |
| 6 | **Done:** CLI inspection/live logs/diff, install/uninstall docs, acceptance script |
| 7 | **Done:** read-only Seatbelt denylist, filtered child environment, `agent_preflight`, `agent_delivery`, minimal context snapshots, provider pause/resume, evidence-strength review prompts |

See `docs/decisions.md` for technical decisions and
`examples/codex-config.toml` for a ready-to-edit Codex configuration.

Additional note: OpenCode's `/api/config` endpoint returns raw provider
credentials. The bridge never calls it and does not expose it through MCP.
