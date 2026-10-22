# Codex–OpenCode Bridge

An MCP bridge that lets Codex delegate bounded coding tasks to OpenCode while
keeping task state, prompts, events, and cancellation under bridge control.

> **Phase 1 status:** the MCP server and full mock task lifecycle are implemented.
> The real OpenCode adapter, Git worktrees, sandboxing, SQLite persistence, the
> daemon, diffs, and cleanup are not implemented yet. Phase 1 does not modify your
> repositories and does not call a model provider.

## What works now

- MCP stdio server (`@modelcontextprotocol/server` v2)
- Five tools: `agent_spawn`, `agent_status`, `agent_history`, `agent_abort`, `agent_list`
- FIFO queue with configurable concurrency and queue limits
- Explicit task state machine with verified cancellation
- Idempotency keys
- Structured, redacted event history with stable per-task sequence numbers
- Model allowlist and expensive-model authorization gate
- Fail-closed repository root policy
- Mock adapter for tests and protocol validation

## Requirements

- macOS (Apple Silicon tested) or Linux
- Node.js **24 LTS**
- pnpm 10+
- Git
- Codex CLI with MCP support (0.152.0 tested)

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

- `adapter` must be `mock` in Phase 1. `opencode` is reserved for Phase 2.
- `security.allowed_repo_roots` is required for writable tasks. An empty list
  means every repository is rejected.
- `models.allow` is an exact allowlist. A model not in it is rejected with
  `MODEL_NOT_ALLOWED`.
- Models listed in `models.expensive` require `models.allow_expensive: true`.
  The bridge never upgrades models automatically.
- `scheduler.max_concurrent` defaults to 2; `max_queue` defaults to 10.
- The full example also shows history limits, OpenCode compatibility settings,
  and mock timing.

Environment overrides: `BRIDGE_CONFIG`, `BRIDGE_ADAPTER`, `BRIDGE_MODEL`,
`BRIDGE_ALLOWED_ROOTS` (colon-separated), `BRIDGE_MAX_CONCURRENT`,
`BRIDGE_MAX_QUEUE`, `BRIDGE_DEFAULT_TIMEOUT_SECONDS`, `BRIDGE_LOG_LEVEL`,
`BRIDGE_MOCK_SCENARIO`, `BRIDGE_MOCK_DELAY_MS`.

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
  "task": "Add tests for the parser's empty-input branch. Do not modify production code.",
  "repo_root": "/Users/you/Code/example",
  "task_type": "testing",
  "model": "mock/echo",
  "read_only": false,
  "timeout_seconds": 120,
  "idempotency_key": "parser-empty-input-tests"
}
```

### `agent_status`

Returns status, stage, model, session, timings, usage, error, and the last event.
It never calls a model.

### `agent_history`

Returns the delegated task text, the exact prompt sent to the adapter, agent
messages, and tool events. Supports `limit`, numeric `cursor` for older pages,
and `event_types`. Payloads are redacted and truncated.

### `agent_abort`

Cancels a queued task immediately. For a running task it asks the adapter to
stop, waits for a terminal state, and only reports success after the adapter
confirms cancellation. Work already produced is preserved by design.

### `agent_list`

Lists current and historical tasks, newest first, with optional status, repo,
and model filters.

## Observe a task

```text
1. Agent_spawn with a bounded task.
2. Agent_status until the task reaches completed/failed/timed_out/cancelled.
3. Agent_history to see what was actually delegated and what the mock agent did.
4. Agent_list to inspect all tasks.
```

Phase 1 events are explicitly mock-labelled. Do not treat mock tool output or a
mock completion summary as a real test result or a real code change.

## Security boundaries in Phase 1

- Only paths under `security.allowed_repo_roots` are accepted. Writable tasks
  must resolve to a Git top-level.
- The model allowlist is default-deny.
- Expensive models require a local configuration change; a task cannot grant
  itself permission.
- No automatic diff, merge, worktree deletion, or cleanup exists yet.
- History payloads redact common secret keys and reject full process
  environments. This is not a substitute for a filesystem sandbox.
- MCP logs go to stderr. stdout is reserved for the JSON-RPC protocol.

**Known limitation:** Phase 1 runs tasks inside the MCP process. If Codex or the
MCP server exits, tasks do not survive. The bridge does not pretend otherwise.
Cross-process task survival requires the Phase 4 daemon and SQLite persistence.

## Tests

```bash
PATH="/opt/homebrew/opt/node@24/bin:$PATH" pnpm test
```

The current suite has 54 tests covering state transitions, queue behavior,
model/path policies, redaction, event pagination, task lifecycle, idempotency,
timeouts, abort verification, and real MCP stdio calls. All tests use the mock
adapter and do not spend model credits.

## Roadmap

| Phase | Scope |
|---|---|
| 2 | Real OpenCode adapter: private server, session creation, prompt, SSE events, abort, model discovery, error mapping |
| 3 | Git worktrees, diff/untracked inspection, path guards, OpenCode permissions, macOS sandbox backend |
| 4 | SQLite, daemon, Unix socket IPC, queue persistence, restart recovery, usage records |
| 5 | Budget enforcement, log redaction hardening, cleanup plans, independent user approval |
| 6 | CLI (`bridge tasks/status/logs/diff`), live log follow, install/uninstall docs, end-to-end acceptance scripts |

See `docs/decisions.md` for the Phase 0 technical decisions and
`examples/codex-config.toml` for a ready-to-edit Codex configuration.
