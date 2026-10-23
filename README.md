# Codex–OpenCode Bridge

An MCP bridge that lets Codex delegate bounded coding tasks to OpenCode while
keeping task state, prompts, events, and cancellation under bridge control.

> **Phase 6 status:** the task-inspection CLI (`tasks`, `status`, `logs --follow`,
> `diff`), install/uninstall documentation, and an end-to-end acceptance script
> are implemented. Budgets, cleanup, approvals, daemon persistence, and restart
> recovery are in place. A web dashboard is not part of this phase.

## What works now

- MCP stdio server (`@modelcontextprotocol/server` v2)
- Ten tools: `agent_capabilities`, `agent_spawn`, `agent_wait`, `agent_status`, `agent_history`, `agent_message`, `agent_diff`, `agent_abort`, `agent_list`, `agent_cleanup`
- Policy/isolation discovery without a model call, bounded batch waiting, and compact task snapshots
- FIFO queue with configurable concurrency and queue limits
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
  - `bridge tasks`
  - `bridge status`
  - `bridge logs --follow`
  - `bridge diff`
  - `bridge abort` / `bridge message`
  - `--json` output for scripting
- End-to-end mock acceptance script

## Requirements

- macOS (Apple Silicon tested) or Linux
- Node.js **24 LTS**
- pnpm 10+
- Git
- Codex CLI with MCP support (0.152.0 tested)
- OpenCode **2.1.x** for the real adapter (v2.1.2 tested)
- macOS for writable OpenCode tasks (`sandbox-exec`); other platforms are read-only
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
- `models.allow` is an exact allowlist. A model not in it is rejected with
  `MODEL_NOT_ALLOWED`.
- Models listed in `models.expensive` require `models.allow_expensive: true`.
  The bridge never upgrades models automatically.
- `scheduler.max_concurrent` defaults to 2; `max_queue` defaults to 10.

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

Read-only OpenCode tasks run in the target repository with edit, shell,
external-directory, web, subagent, and question permissions denied.

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

### `agent_capabilities`

Call with `{}` before delegating. Reads the **daemon's** effective model policy,
default model, scheduler limits, soft budgets, and execution restrictions. Each
configured model has a `permitted` flag and an error code when policy blocks it.
This does not start OpenCode, query provider quotas, or invoke a model. Model
availability is validated at task start; allowlisting alone does not prove an
ID exists upstream. Mock capabilities and results are explicitly simulated.

The response also discloses the lack of OS read isolation, per-file scope
enforcement, and independent verification of OpenCode's internal model calls.
Do not delegate writable work if your task requires boundaries the bridge does
not enforce. In that case Codex should implement the changes directly.

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
  "timeout_seconds": 120,
  "idempotency_key": "parser-edge-cases"
}
```

For the OpenCode adapter, set `read_only: false` only when you want an isolated
worktree and are on macOS with `sandbox-exec`. Writable tasks are edit-only;
Codex remains responsible for running tests and merging.

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
tasks continue. Task execution timeouts still come from `agent_spawn`.

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
fetching old events. The task header omits the original instruction text by
default (`task_text_omitted: true`); pass `include_task: true` to include it.
Recorded prompt events remain available. Payloads are redacted and truncated
according to the configured history limits.

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

### `agent_diff`

Returns the task worktree's Git status, modified/added/deleted/untracked files,
line counts, and a patch. Use `file` to inspect one path and `max_chars` to limit
the patch. Worktrees are retained after completion or failure for review.

### `agent_abort`

Cancels a queued task immediately. For a running task it asks OpenCode to
interrupt the session, waits for a terminal state, and stops the private server
process group if needed. Work already produced is preserved by design.

### `agent_list`

Lists current and historical tasks, newest first, with optional status, repo,
and model filters. Defaults to compact snapshots; use `detail: "full"` for all
status fields. `total` is the number returned, not a count of all stored tasks.

## Observe a task

```text
1. agent_capabilities to inspect model policy and isolation limits.
2. agent_list with project/status filters to check for existing work.
3. agent_spawn for a bounded task worth the handoff cost; use an idempotency key.
4. agent_wait on the returned task ID(s); continue independent Codex work between waits.
5. agent_history (incremental after sequence) and agent_diff to review actual activity and changes.
6. Run relevant tests yourself and integrate only reviewed changes.
7. If needed, agent_message continues the session; wait on its NEW turn task ID.
8. agent_cleanup dry-run to inspect retained resources after integration.
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
bridge tasks --repo /Users/you/Code/example --json
bridge status <task-id>
bridge logs <task-id>
bridge logs --follow <task-id>
bridge logs <task-id> --types tool.called,tool.completed
bridge diff <task-id>
bridge diff <task-id> --file src/parser.ts --max-chars 20000
bridge abort <task-id>
bridge message <task-id> "Please add the missing edge-case assertion."
```

`bridge logs --follow` polls the daemon and prints new events until Ctrl-C.
`bridge diff` shows the worktree file summary and patch; large patches are
truncated unless a larger `--max-chars` is supplied.

## Budgets and cleanup

`models.max_tokens` and `models.max_cost_usd` are soft budgets. Usage events are
checked while a task runs; exceeding a limit requests cancellation and records
`BUDGET_EXCEEDED`. Cost enforcement requires the provider to report a known cost.

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
bridge daemon status
bridge daemon stop
```

Before an approved dirty worktree is force-removed, the bridge saves its patch
under `data_dir/approvals/<approval-id>.patch`. An MCP tool call alone can never
consume an approval.

## Security boundaries in Phase 6

- Only paths under `security.allowed_repo_roots` are accepted.
- Writable OpenCode tasks are enabled only on macOS with `sandbox-exec`.
- Writable tasks use a detached Git worktree; uncommitted main-tree changes are
  not carried into the worktree.
- Writable sessions are edit-only: shell, external directory, web, subagent,
  and question permissions are denied.
- The Seatbelt profile confines writes to the worktree, its task-local Git
  metadata, task data/temp directories, and OpenCode's own state/cache/log
  directories. OpenCode snapshots are disabled, and the main repository's Git
  object store is not writable.
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

**Known limitations:** the Seatbelt profile confines writes but still allows
reads broadly; read-only tasks rely on OpenCode permissions rather than an OS
read sandbox. Do not run untrusted repositories without reviewing this boundary.
Writable tasks are edit-only, so OpenCode cannot run tests. Worktrees and logs
are retained by default; `agent_cleanup` and the local approval CLI remove safe
resources, while dirty worktrees require user approval. The main repository's
Git object store is deliberately not writable from the sandbox. Tasks now survive MCP
adapter exits through the daemon, but a daemon crash cannot resume an in-flight
OpenCode turn; those tasks are marked interrupted and preserved for review.

## Tests and acceptance

```bash
PATH="/opt/homebrew/opt/node@24/bin:$PATH" pnpm test
```

The default suite covers state transitions, queues,
model/path policies, redaction, event pagination, task lifecycle, idempotency,
timeouts, abort verification, MCP stdio, OpenCode HTTP/SSE, managed process
startup, worktrees, diffs, session continuation, SQLite persistence, daemon
IPC/reconnect, restart recovery, budgets, cleanup approvals, CLI approval and
inspection, Seatbelt write confinement, and fake OpenCode adapter lifecycles.
It also checks capability policy reporting, batch wait completion/deadlines,
permission wakeups, input bounds, read-only defaults, compact/full results, and
incremental history headers through MCP and daemon IPC.
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

See `docs/decisions.md` for technical decisions and
`examples/codex-config.toml` for a ready-to-edit Codex configuration.

Additional note: OpenCode's `/api/config` endpoint returns raw provider
credentials. The bridge never calls it and does not expose it through MCP.
