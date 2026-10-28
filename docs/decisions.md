# Phase 0 technical decisions

Date: 2026-10-22  
Status: accepted for Phase 1

## Environment findings

- Host: macOS 26.5.2 on Apple Silicon.
- The installed Node 23.11.0 is EOL and is not supported by `@opencode-ai/sdk@1.19.4`
  (supported ranges: `^22.12`, `^24`, `>=26`).
- Homebrew `node@24` 24.22.1 was installed keg-only. The bridge uses
  `/opt/homebrew/opt/node@24/bin/node`; Node 23 remains the shell default.
- OpenCode is v2.1.2. Its current HTTP API is served under `/api`, uses Basic
  authentication, and exposes SSE events at `/api/event`.
- Codex CLI is 0.152.0 and supports stdio MCP servers.
- The official MCP TypeScript SDK is now v2: `@modelcontextprotocol/server@2.3.1`.
  `serveStdio` serves legacy clients by default, which is required for compatibility
  with current MCP hosts.
- `/usr/bin/sandbox-exec` is present, but it is not used in Phase 1 because there
  are no real filesystem-writing tasks yet.

## Decisions

1. **Runtime:** Node 24 LTS. The project declares `engines.node >=24 <25` and
   documents the Homebrew keg-only path.
2. **OpenCode target:** v2.1.x only. The real adapter will call `/api/info` and
   reject unknown versions with `OPENCODE_INCOMPATIBLE` instead of guessing.
3. **OpenCode integration:** use `@opencode-ai/sdk@1.19.4` and its `./v2` typed
   client, wrapped in `OpenCodeAdapter`. Other modules never import the SDK.
4. **MCP:** use `@modelcontextprotocol/server@2.3.1` and `serveStdio`. No normal
   logging is allowed on stdout; pino writes to stderr.
5. **Process model:** Phase 1 is in-process. A daemon/IPC layer is deferred to
   Phase 4. Phase 1 tasks do not survive MCP server exit, and the README says so.
6. **Worktrees:** the bridge will create and own Git worktrees in Phase 3 with
   `git worktree`. It will not rely on OpenCode's worktree API, so that audit and
   cleanup rules remain under bridge control.
7. **Real OpenCode servers:** each task will get a private `opencode serve`
   process on `127.0.0.1`, a per-task database, a random Basic-auth password,
   and an injected fail-closed permission config. This is Phase 2 work.
8. **Model policy:** exact `provider/model` allowlist, default deny, no automatic
   escalation to expensive models. Internal model calls (titles, compaction,
   subagents) must be constrained or explicitly reported.
9. **Tests:** mock adapter only by default. Live OpenCode or paid model tests must
   be opt-in and are not part of `pnpm test`.

## Deferred risks

- The OpenCode v2 API is experimental. The adapter and version gate isolate it,
  but future OpenCode releases may require bridge changes.
- Worktree isolation is not a filesystem sandbox. Phase 3 must add OS-level
  confinement or refuse writable tasks with `SANDBOX_UNAVAILABLE`.
- Credentials available to a local OpenCode process are a residual risk. A
  dedicated low-privilege provider key and filesystem confinement are planned.

## Phase 2 update

- The `@opencode-ai/sdk@1.19.4` `./v2` client did not match the installed
  OpenCode 2.1.2 HTTP contract. Its session/prompt shapes used the older
  `noReply`/`parts` model instead of the current `resume`/`text` API. The SDK
  dependency was removed rather than forced into an unverified adapter.
- The bridge now uses a narrow, typed HTTP client against `/api`, verified
  against a live OpenCode 2.1.2 server:
  - `GET /api/info`, `/api/model`, `/api/session/{id}`,
    `/api/session/{id}/message`, `/api/session/active`
  - `POST /api/session`, `/api/session/{id}/prompt`,
    `/api/session/{id}/interrupt`
  - `GET /api/event` (SSE)
- Each task gets a private `opencode serve` process with a random Basic-auth
  password, isolated `OPENCODE_DB`, a version gate, and a process-group stop.
- The adapter is intentionally read-only until Phase 3. Writable tasks return
  `SANDBOX_UNAVAILABLE`; OpenCode permissions cannot replace an OS sandbox.
- The live smoke test uses `resume: false`, so it exercises server startup,
  model discovery, session creation, prompt admission, and SSE without invoking
  a model provider.

### Security verification notes

- A live OpenCode 2.1.2 server was probed with `OPENCODE_CONFIG_CONTENT`. The
  injected permission document appeared as the highest-priority config document,
  so the read-only rules are actually loaded.
- `GET /api/config` returns raw provider settings, including API keys. The bridge
  must never call or expose this endpoint. The HTTP client intentionally has no
  method for it.

## Phase 3 update

- Writable OpenCode tasks now require a Git worktree created by the bridge.
  Worktrees use `git worktree add --detach` at the recorded HEAD commit, under
  the bridge data directory, and are never created from uncommitted main-tree
  changes. Dirty main-tree files are reported as an event.
- Diff inspection covers tracked modifications, staged additions, deletions,
  untracked files, line counts, and a size-limited patch.
- On macOS, writable servers run under `sandbox-exec` with a generated Seatbelt
  profile. Writes are confined to the worktree, the task-local worktree Git
  metadata directory, task data/temp directories, and OpenCode's own
  log/shell/snapshot/state/cache directories.
- OpenCode snapshots are disabled for bridge sessions. The main repository's Git
  object store is deliberately not writable; a worktree `git add` attempt is
  denied by the sandbox. Diff inspection only reads the working tree and the
  recorded base commit.
- Writable OpenCode permissions are edit-only: edit/write/patch are allowed,
  while shell, external directories, web tools, subagents, and questions remain
  denied. Test execution stays with Codex in Phase 3.
- On non-macOS platforms, or if `sandbox-exec` is unavailable, writable tasks
  fail with `SANDBOX_UNAVAILABLE`. No permission-only fallback is presented as
  an OS sandbox.
- Worktrees are retained after completion, failure, or abort. Phase 5 adds
  conservative cleanup and an independent local approval CLI.

## Session continuation

- `agent_message` does not mutate a terminal task back to running. It creates a
  new turn task with a new task ID, linked by `parent_task_id` and
  `root_task_id`, and reuses the original `session_id`, worktree, and model
  policy.
- The OpenCode server is restarted with the same per-task database, so the
  existing session can be loaded and prompted again.
- Only one active task is allowed per lineage; follow-up messages return
  `TASK_BUSY` while another turn is running.

## Phase 4 update

- SQLite is the source of truth for tasks, events, sessions, worktrees, and model
  usage. The schema is migration-versioned via `PRAGMA user_version` and a
  `schema_migrations` audit table.
- The MCP adapter is thin by default: it connects to a local daemon over a Unix
  socket. The daemon owns the queue, task manager, adapter, and OpenCode
  processes. MCP exit no longer stops tasks.
- Socket access is restricted by a `0700` parent directory and a `0600` socket.
  The daemon state file is also `0600`.
- On daemon startup, persisted non-terminal tasks are marked `interrupted` with
  `SESSION_LOST`. They are not re-executed, because repeating a partially
  executed coding task could duplicate or corrupt changes. Worktrees and events
  are retained.
- `BRIDGE_INPROCESS=1` is a test/development fallback only; it does not survive
  MCP exit and is not the default.
- Model usage is persisted separately from task state. Approvals and cleanup
  records now back the Phase 5 cleanup workflow; destructive removal still
  requires the local CLI approval channel.

## Phase 5 update

- Token and cost limits are soft, event-driven budgets. When a usage event
  exceeds a configured limit, the bridge requests cancellation and marks the
  task failed with `BUDGET_EXCEEDED`. Cost limits only apply when cost is known.
- Cleanup is conservative. `agent_cleanup` defaults to a dry-run plan. Clean
  worktrees can be removed automatically; dirty worktrees produce a persistent
  approval record and are never removed by MCP.
- The only approval channel is the local `bridge approve <id>` CLI, which talks
  to the daemon over the user-only Unix socket. Before force-removal, the
  worktree patch is saved under `data_dir/approvals/`.
- Old `opencode-*.log` files are removed by retention policy; `daemon.log` is
  preserved. Cleanup actions are written to `cleanup_records`.
- The CLI also provides `bridge cleanup`, `bridge daemon status`, and
  `bridge daemon stop`. Full task inspection/log-follow CLI remains Phase 6.

## Phase 6 update

- The CLI is a thin client over the same daemon IPC protocol used by MCP. It
  supports task listing, status, history/log following, diff review, abort,
  message continuation, cleanup, approval, and daemon lifecycle commands.
- `logs --follow` uses a forward sequence cursor (`after`) rather than re-reading
  the whole event log.
- The acceptance script runs typecheck, tests, build, and a full mock MCP request
  through the daemon and SQLite. Live OpenCode validation remains opt-in and
  makes no model call.
- Install/uninstall instructions use `pnpm link --global`; Codex continues to use
  an absolute path to the built MCP server.

## Codex delegation ergonomics (2026-10-23)

- `agent_capabilities` reads effective daemon policy without starting OpenCode
  or invoking a model. Configured allowlist entries are distinct from live
  availability; actual provider/model resolution remains at task start.
- `agent_preflight` validates the exact path, Git state, workspace plan, model
  policy, isolation, permissions, and budgets before a task is queued.
- `agent_delivery` returns a base commit, changed files, patch hash, observed
  commands, actual model resolution, and explicit verification gaps.
- Provider auth, quota, and region errors set a daemon-wide pause; only the
  local `bridge resume` CLI clears it. The bridge never switches models
  automatically.
- `agent_wait` waits inside the daemon for any of up to eight tasks. Its maximum
  wait is 50 seconds, below the documented 60-second MCP request timeout. A wait
  timeout never stops execution. Terminal states and permission requests wake
  the caller; IPC disconnect cancels the wait but not the task.
- MCP spawn defaults to read-only. Write support still means workspace-level
  Seatbelt write confinement, not per-file delegation enforcement or OS read
  isolation. The capability response exposes these limits rather than claiming
  stronger guarantees.
- Status, wait and list default to compact snapshots with explicitly truncated
  long result summaries. Full readback is opt-in; stored records are unchanged.
  History headers omit the original task text by default to avoid repeating it
  on every forward-cursor request.
- Server instructions keep planning/review with Codex, treat worker output as
  untrusted data, and direct Codex to stop on account/quota/region errors.
  A persistent daemon-wide account circuit breaker, stronger filesystem read
  isolation, and per-file write authorization remain outside this change.

### Live verification follow-up

- A real read-only task and same-session follow-ups were exercised with the
  locally allowlisted `opencode/deepseek-v4.1-flash-free` on OpenCode 2.1.2.
  The task read only `package.json`; the provider reported zero cost.
- Live SSE uses `session.tool.*`, `session.step.*`, and `session.text.*` names.
  The event adapter now accepts these alongside the older `session.next.*`
  family, preserving tool payloads and omitting redundant text deltas.
- Live message pages are newest-first and expose `time.created`. Final readback
  now orders messages by that timestamp before selecting the latest answer;
  otherwise a follow-up could return an older turn's answer as its summary.
  Fake API fixtures now reproduce this ordering and distinct turn replies.

## Phase 7 security and delivery follow-up

- Read-only OpenCode tasks use a macOS Seatbelt denylist profile by default.
  macOS 26 rejects narrow `file-read` allow lists, so the profile allows runtime
  reads but denies file data under the user home, external mounts, and system
  temp. Allowed paths are re-allowed after the deny rules. In gateway mode the
  writable profile applies the same read deny overlay while still allowing the
  worktree, worktree Git metadata, task data, and isolated config tree.
- The OpenCode child environment is filtered to basic runtime variables.
  Provider keys are removed entirely in gateway mode; unrelated cloud, SSH,
  Git-host, and CI credentials are never inherited.
- `agent_preflight` validates the repository root, Git top level/HEAD, model
  policy, planned workspace/worktree, effective permissions, isolation, budgets,
  and timeout before a task is created. It reports unverified provider
  availability and other known gaps.
- `agent_delivery` returns the recorded base commit, changed files, patch and
  SHA-256, observed commands and exit codes, actual model resolution when
  available, usage/cost, and explicit verification status. The bridge never
  claims it ran tests or commands it did not run.
- OpenCode prompts now require review findings to include location, trigger,
  evidence, and a confidence label (`reproduced`, `static-inference`, or
  `needs-confirmation`), and to say "not run" when shell is unavailable.
  Review/analysis replies must end with a fenced JSON findings block; delivery
  parses it and reports `findings.verified: false` when it is missing,
  malformed, or truncated.
- Read-only tasks can request a minimal context snapshot. The bridge validates
  repository-relative files, rejects traversal, limits file count/bytes, hashes
  each file, copies only those files into a task-local workspace, and records a
  manifest. A follow-up turn can add files through `agent_message.context_files`;
  the worker cannot expand its own scope. SQLite schema v2 stores the snapshot
  path and file list.
- `agent_events` adds a long-polling incremental event channel: it waits for
  events after a sequence cursor, returns immediately when the task is terminal,
  and never cancels the task on timeout.
- Provider authentication, quota, and region errors set a daemon-wide pause.
  New spawns, messages, and preflights fail with `PROVIDER_PAUSED`; only the
  local `bridge resume` CLI clears it. The bridge never switches models or
  providers to work around the restriction.
- A short-lived provider probe reads the selected model's OpenAI-compatible
  `baseURL` and key. The bridge then starts a per-task localhost gateway and
  injects a dummy key into OpenCode's custom provider config. The task runs with
  an isolated HOME/XDG tree, no user MCP/plugin config, and (on macOS) a
  Seatbelt profile that denies all network except the gateway port. The gateway
  replaces the dummy key with the real key and forwards `/v1/*` to the provider.
  `security.model_gateway` defaults to `require`; `auto` falls back to direct
  access for unsupported providers and `off` disables the gateway.

## Caller-controlled task duration (2026-10-25)

- Task execution no longer has a default automatic timeout. A missing
  `scheduler.default_timeout_seconds` now resolves to `0`, meaning the task runs
  until the caller stops it. `agent_abort` is the supported stop channel and
  still verifies that the adapter reached a terminal state.
- A positive `timeout_seconds` on `agent_spawn` remains available as an explicit
  hard deadline. `scheduler.default_timeout_seconds` can set a longer default
  deadline for new tasks, and `scheduler.max_timeout_seconds` defaults to
  604800 seconds (7 days), with a configuration maximum of one year.
- `agent_wait` and `agent_events` timeouts only end those calls; they never
  request cancellation. This keeps stopping under caller control instead of
  conflating observation timeouts with task lifetime.
- Trade-off: a stuck or forgotten task occupies a daemon concurrency slot until
  `agent_abort`, daemon shutdown, or adapter process exit. The capability and
  preflight responses disclose whether a default deadline is active.

## Turn correctness, delivery snapshots, and scoped writes (2026-10-27)

- OpenCode completion is now turn-scoped. Before prompting, the adapter records
  the existing message IDs, count, cumulative usage, and outcome. A turn only
  completes after a new assistant message appears after the prompt; stale
  `session.idle`, previous assistant replies, and pre-prompt poll results are
  ignored. Polling starts after prompt admission, and only current-turn messages
  are emitted to history.
- Turn usage is the delta from the session baseline. `usage.updated` carries both
  turn and cumulative session usage; delivery exposes both scopes explicitly.
  `session.usage.updated` events are normalized while the task runs instead of
  waiting for final readback. Budget thresholds at 70%/90% are recorded, and a
  final `finish: "stop"` step suppresses a pointless post-completion abort.
- Delivery now freezes an immutable snapshot after the worker stops. The snapshot
  contains the full patch, stable SHA-256, byte count, file counts, omitted
  files, turn/session usage, and capture time. `agent_delivery` reads the
  snapshot even after cleanup or coordinator edits; legacy tasks fall back to a
  live diff. A removed worktree reports `workspace_removed` rather than a
  worktree-creation error. `include_patch: false` returns metadata only.
- Writable tasks may declare `write_paths` (files or directories ending in `/`).
  OpenCode receives scoped edit/write/patch rules, and the bridge checks the
  final diff, failing with `SCOPE_VIOLATION` and preserving the worktree on a
  violation. `read_paths` is declared review scope, not a read sandbox.
- `workspace_from_task_id` lets a new read-only session reuse a completed
  Bridge-owned worktree/snapshot after validating the source task, repository,
  and managed path. Writable continuation remains `agent_message`.
- `agent_result` returns the current turn's reply and metadata without patch
  text. Diff outputs now include `full_patch_sha256`, full byte counts,
  `omitted_files`, and a truncation reason; untracked line counts follow `wc -l`.
- Capabilities include build SHA/dirty/built_at and the effective config path and
  revision; `task.created`/`task.resumed` record a policy snapshot for historical
  explanation.

## OpenCode 2.2 compatibility (2026-10-28)

- The installed OpenCode is now v2.2.0. The bridge default compatibility gate is
  `2.2.x`; existing deployments pinned to `2.1.x` can keep that override.
- The live no-model smoke suite was updated to assert 2.2.0 and passed all three
  checks: private read-only sandbox startup, model discovery, session creation,
  no-reply prompt admission, SSE `server.connected`, and the gateway-backed
  session with isolated config and localhost-only networking.
- No `/api` request/response shape changes required adapter changes. Event names
  remain in the `session.tool.*`, `session.step.*`, `session.text.*`,
  `session.usage.updated`, and `session.execution.*` families already handled by
  the 2.1 adapter path.
- Historical references to 2.1.x elsewhere in this document describe the
  environment at the time of those phases; they are not the current default.

## Automatic local conversation display

- The daemon now serves a read-only local viewer. Successful task creation and
  follow-up turns focus their task in the viewer and open the default browser
  when no viewer is polling. The UI uses forward event cursors, not transcript
  exports or extra model calls. Browser-opening failures do not fail tasks.
- The HTTP listener uses an ephemeral loopback port, a per-process random
  capability in the URL fragment, authenticated API headers, strict Host and
  Origin checks, no CORS, no-store headers, CSP, and text-only rendering of
  untrusted messages. There are no HTTP mutation/approval/filesystem endpoints.
- The interface reads redacted audit events rather than exposing the raw task
  instruction field. It shows original delegation, actual prompt, assistant
  response and tool execution separately. Replies use final message readback;
  per-token streaming is outside this change.
- The transcript is chat-shaped rather than a raw event timeline. Codex
  delegation and follow-up messages render on the right, OpenCode replies on the
  left, and tool/shell activity renders as grouped, collapsible cards. Turns
  sharing a root task are merged into one conversation for context, while the
  default view hides low-level audit events behind the existing toggle. The
  visual system is monochrome and Vercel/Geist-inspired, with light and dark
  modes.
- Conversation messages use the delegation payload limit rather than the compact
  audit limit, so assistant replies are not cut at the ordinary event-payload
  boundary. Long messages still collapse to a preview in the viewer.
- `agent_viewer` and `bridge viewer` recover the live URL; spawn/message also
  return `viewer_url`. Headless users can disable auto-open independently.
- This is a local viewer usable with the current stdio integration. Optional
  embedded MCP Apps depend on host support, as described in the
  [MCP Apps overview](https://apps.extensions.modelcontextprotocol.io/api/documents/overview.html).
