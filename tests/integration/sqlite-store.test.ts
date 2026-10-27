import { realpath, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openSqliteStore } from "../../src/storage/sqlite-store.js";
import type { TaskRecord } from "../../src/types.js";
import { emptyUsage } from "../../src/types.js";
import { makeTempDir } from "../helpers/fixtures.js";

function task(): TaskRecord {
  const now = new Date().toISOString();
  return {
    id: "task_store_test",
    parent_task_id: null,
    root_task_id: "task_store_test",
    turn: 1,
    opencode_task_id: "task_store_test",
    idempotency_key: "store-key",
    idempotency_fingerprint: "fingerprint",
    task: "store test",
    repo_root: "/tmp/repo",
    task_type: "coding",
    model: "mock/echo",
    provider_id: "mock",
    model_id: "echo",
    model_variant: null,
    read_only: false,
    timeout_seconds: 30,
    status: "completed",
    stage: "completed",
    session_id: "ses_store",
    server_pid: 1234,
    worktree_path: "/tmp/worktree",
    worktree_git_dir: "/tmp/repo/.git/worktrees/task_store_test",
    base_commit: "a".repeat(40),
    context_path: null,
    workspace_path: null,
    context_files: [],
    read_paths: [],
    write_paths: [],
    created_at: now,
    started_at: now,
    ended_at: now,
    error_code: null,
    error_message: null,
    result_summary: "done",
    usage: { ...emptyUsage(), input_tokens: 10, output_tokens: 5, total_tokens: 15, cost_usd: 0.01, cost_known: true },
    last_event_sequence: 1,
    stop_reason: null,
    cancel_requested_at: null,
  };
}

describe("SqliteStore", () => {
  it("persists and reloads tasks, events, sessions, worktrees, and usage", async () => {
    const dir = await realpath(await makeTempDir());
    const path = join(dir, "bridge.db");
    try {
      const store = openSqliteStore(path);
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      const record = task();
      record.read_paths = ["README.md"];
      record.write_paths = ["src/"];
      store.saveTask(record);
      store.appendEvent({
        event_id: "evt_1",
        task_id: record.id,
        session_id: record.session_id,
        timestamp: record.created_at,
        sequence: 1,
        source: "bridge",
        event_type: "task.completed",
        payload: { ok: true },
      });
      store.saveSession(record);
      store.saveWorktree(record);
      store.saveUsage(record);
      store.close();

      const reopened = openSqliteStore(path);
      const tasks = reopened.loadTasks();
      const events = reopened.loadEvents();
      expect(tasks).toHaveLength(1);
      expect(tasks[0]).toMatchObject({
        id: record.id,
        status: "completed",
        session_id: "ses_store",
        server_pid: 1234,
        read_paths: ["README.md"],
        write_paths: ["src/"],
        usage: { input_tokens: 10, output_tokens: 5, cost_usd: 0.01 },
      });
      expect(events).toHaveLength(1);
      expect(events[0]?.event_type).toBe("task.completed");
      reopened.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
