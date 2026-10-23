import { realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MockAdapter } from "../../src/adapters/mock/mock-adapter.js";
import { createServices } from "../../src/app.js";
import type { BridgeConfig } from "../../src/config.js";
import { createLogger } from "../../src/logging.js";
import { openSqliteStore } from "../../src/storage/sqlite-store.js";
import type { TaskRecord } from "../../src/types.js";
import { emptyUsage } from "../../src/types.js";
import { makeTempDir } from "../helpers/fixtures.js";

function config(dir: string): BridgeConfig {
  return {
    adapter: "mock",
    log_level: "silent",
    data_dir: join(dir, "data"),
    scheduler: {
      max_concurrent: 2,
      max_queue: 5,
      default_timeout_seconds: 30,
      max_timeout_seconds: 60,
    },
    models: {
      default: "mock/echo",
      allow: ["mock/echo"],
      expensive: [],
      allow_expensive: false,
      max_cost_usd: null,
      max_tokens: null,
    },
    security: {
      allowed_repo_roots: [dir],
      require_git_for_writes: true,
      allow_external_directories: false,
      read_sandbox: "auto",
      model_gateway: "auto",
    },
    opencode: {
      binary: "opencode",
      compatibility: "2.1.x",
      startup_timeout_ms: 5000,
    },
    history: {
      default_limit: 20,
      max_limit: 100,
      max_payload_chars: 4000,
      max_delegation_chars: 50_000,
    },
    mock: { scenario: "success", delay_ms: 5 },
  };
}

function runningTask(dir: string): TaskRecord {
  const now = new Date().toISOString();
  return {
    id: "task_recovery_running",
    parent_task_id: null,
    root_task_id: "task_recovery_running",
    turn: 1,
    opencode_task_id: "task_recovery_running",
    idempotency_key: null,
    idempotency_fingerprint: null,
    task: "unfinished task",
    repo_root: dir,
    task_type: "coding",
    model: "mock/echo",
    provider_id: "mock",
    model_id: "echo",
    model_variant: null,
    read_only: true,
    timeout_seconds: 30,
    status: "running",
    stage: "running",
    session_id: "ses_recovery",
    server_pid: null,
    worktree_path: null,
    worktree_git_dir: null,
    base_commit: null,
    context_path: null,
    context_files: [],
    created_at: now,
    started_at: now,
    ended_at: null,
    error_code: null,
    error_message: null,
    result_summary: null,
    usage: emptyUsage(),
    last_event_sequence: 0,
    stop_reason: null,
    cancel_requested_at: null,
  };
}

describe("TaskManager recovery", () => {
  it("marks a persisted running task interrupted instead of re-running it", async () => {
    const dir = await realpath(await makeTempDir());
    const store = openSqliteStore(join(dir, "bridge.db"));
    try {
      store.saveTask(runningTask(dir));
      const services = createServices(
        config(dir),
        new MockAdapter({ scenario: "success", delayMs: 5 }),
        createLogger("silent"),
        store,
      );

      const view = await services.service.status("task_recovery_running");
      expect(view.status).toBe("interrupted");
      expect(view.error?.code).toBe("SESSION_LOST");
      expect(view.result_summary).toBeNull();

      const history = await services.service.history("task_recovery_running", { limit: 20 });
      expect(history.events.map((event) => event.event_type)).toContain("task.interrupted");
      expect(services.manager.list({ limit: 10 })[0]?.status).toBe("interrupted");

      await services.manager.shutdown();
    } finally {
      store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("reloads completed tasks and history without executing them again", async () => {
    const dir = await realpath(await makeTempDir());
    const store = openSqliteStore(join(dir, "bridge.db"));
    try {
      const first = createServices(
        config(dir),
        new MockAdapter({ scenario: "success", delayMs: 5 }),
        createLogger("silent"),
        store,
      );
      const spawned = await first.service.spawn({
        task: "persist me",
        repo_root: dir,
        task_type: "analysis",
        model: "mock/echo",
        read_only: true,
        timeout_seconds: 10,
      });
      await first.manager.waitForTerminal(spawned.task.task_id, 5000);
      await first.manager.shutdown();

      const second = createServices(
        config(dir),
        new MockAdapter({ scenario: "success", delayMs: 5 }),
        createLogger("silent"),
        store,
      );
      const reloaded = await second.service.status(spawned.task.task_id);
      expect(reloaded.status).toBe("completed");
      const history = await second.service.history(spawned.task.task_id, { limit: 100 });
      expect(history.events.map((event) => event.event_type)).toContain("task.completed");
      expect(second.manager.list({ limit: 10 })).toHaveLength(1);
      await second.manager.shutdown();
    } finally {
      store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
