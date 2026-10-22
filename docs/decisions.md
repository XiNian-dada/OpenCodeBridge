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
