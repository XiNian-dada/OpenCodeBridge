# Codex–OpenCode Bridge

An MCP bridge that lets Codex delegate bounded coding tasks to OpenCode while
keeping task state, prompts, events, and cancellation under bridge control.

> **Phase 4 status:** SQLite persistence, an auto-started local daemon, Unix-socket
> IPC, and restart recovery are implemented. Tasks survive MCP adapter restarts.
> A daemon restart marks unfinished tasks interrupted instead of re-running them.
> Automatic cleanup and the CLI remain future work.

## What works now

- MCP stdio server (`@modelcontextprotocol/server` v2)
- Seven tools: `agent_spawn`, `agent_status`, `agent_history`, `agent_message`, `agent_diff`, `agent_abort`, `agent_list`
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

### `agent_spawn`

Creates and enqueues a task. Returns a task ID immediately.

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

### `agent_status`

Returns status, stage, model, session, timings, usage, error, and the last event.
It never calls a model.

### `agent_history`

Returns the delegated task text, the exact prompt sent to the adapter, agent
messages, tool events, shell events, and Bridge/OpenCode server events. Supports
`limit`, numeric `cursor` for older pages, and `event_types`. Payloads are
redacted and truncated.

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
and model filters.

## Observe a task

```text
1. agent_spawn with a bounded task.
2. agent_status until the task reaches completed/failed/timed_out/cancelled.
3. agent_history to see the delegated prompt, tool calls, shell commands, and messages.
4. agent_diff to review the worktree changes before accepting or merging.
5. agent_message to ask the same OpenCode session for a follow-up turn.
6. agent_list to inspect all tasks.
```

Mock events are explicitly mock-labelled. Real OpenCode events are obtained from
the session API and SSE stream; no execution summary is synthesized as if it
were a tool record.

## Security boundaries in Phase 4

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
- MCP logs go to stderr. stdout is reserved for the JSON-RPC protocol.

**Known limitations:** the Seatbelt profile confines writes but still allows
reads broadly; read-only tasks rely on OpenCode permissions rather than an OS
read sandbox. Do not run untrusted repositories without reviewing this boundary.
Writable tasks are edit-only, so OpenCode cannot run tests. Worktrees and logs
are retained until cleanup support is added. The main repository's Git object
store is deliberately not writable from the sandbox. Tasks now survive MCP
adapter exits through the daemon, but a daemon crash cannot resume an in-flight
OpenCode turn; those tasks are marked interrupted and preserved for review.

## Tests

```bash
PATH="/opt/homebrew/opt/node@24/bin:$PATH" pnpm test
```

The default suite has 81 passing tests. It covers state transitions, queues,
model/path policies, redaction, event pagination, task lifecycle, idempotency,
timeouts, abort verification, MCP stdio, OpenCode HTTP/SSE, managed process
startup, worktrees, diffs, session continuation, SQLite persistence, daemon
IPC/reconnect, restart recovery, Seatbelt write confinement, and fake OpenCode
adapter lifecycles. All default tests are free.

A live OpenCode smoke test is opt-in and makes **no model call** (it admits a
prompt with `resume: false`):

```bash
OPENCODE_LIVE=1 PATH="/opt/homebrew/opt/node@24/bin:$PATH" pnpm test
```

It starts a real private OpenCode 2.1 server under the Seatbelt sandbox, checks
the version and models, creates a session, admits a no-reply prompt, and observes
`server.connected`. The live test passed against OpenCode 2.1.2 on this machine.

## Roadmap

| Phase | Scope |
|---|---|
| 2 | **Done:** real OpenCode adapter, private server, SSE, abort, model discovery, usage readback |
| 3 | **Done:** Git worktrees, diff inspection, macOS Seatbelt write confinement, edit-only writable tasks |
| 4 | **Done:** SQLite, daemon, Unix socket IPC, queue persistence, restart recovery, usage records |
| 5 | Budget enforcement, log redaction hardening, cleanup plans, independent user approval |
| 6 | CLI (`bridge tasks/status/logs/diff`), live log follow, install/uninstall docs, end-to-end acceptance scripts |

See `docs/decisions.md` for technical decisions and
`examples/codex-config.toml` for a ready-to-edit Codex configuration.

Additional note: OpenCode's `/api/config` endpoint returns raw provider
credentials. The bridge never calls it and does not expose it through MCP.
