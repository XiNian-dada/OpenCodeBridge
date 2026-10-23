import { readdir, realpath, rm, stat, utimes, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createServices } from "../../src/app.js";
import type { BridgeConfig } from "../../src/config.js";
import type {
  AbortResult,
  AdapterContext,
  AdapterProbe,
  AdapterRunResult,
  AdapterSession,
  AgentAdapter,
} from "../../src/adapters/adapter.js";
import { createLogger } from "../../src/logging.js";
import { emptyUsage, type TaskRecord } from "../../src/types.js";
import { makeGitRepo, makeTempDir } from "../helpers/fixtures.js";

class WritableTestAdapter implements AgentAdapter {
  readonly name = "cleanup-test";
  readonly supportsWrites = true;
  readonly requiresIsolatedWorktree = true;

  constructor(private readonly writeFile: boolean) {}

  async probe(): Promise<AdapterProbe> {
    return { name: this.name, version: "1", compatible: true };
  }

  buildPrompt(task: TaskRecord): string {
    return task.task;
  }

  async start(task: TaskRecord, _prompt: string, context: AdapterContext): Promise<AdapterRunResult> {
    if (task.worktree_path === null) throw new Error("worktree missing");
    context.onSession({
      id: "ses_cleanup",
      model: task.model,
      provider_id: task.provider_id,
      worktree_path: task.worktree_path,
    });
    if (this.writeFile) {
      await writeFile(join(task.worktree_path, "review-me.txt"), "unreviewed\n", "utf8");
    }
    return { summary: "done", usage: emptyUsage() };
  }

  async abort(_session: AdapterSession): Promise<AbortResult> {
    return { stopped: true };
  }
}

function config(dir: string): BridgeConfig {
  return {
    adapter: "mock",
    log_level: "silent",
    data_dir: join(dir, "data"),
    cleanup: { log_retention_days: 30, worktree_retention_days: 0 },
    scheduler: { max_concurrent: 1, max_queue: 5, default_timeout_seconds: 30, max_timeout_seconds: 60 },
    models: { default: "mock/echo", allow: ["mock/echo"], expensive: [], allow_expensive: false, max_cost_usd: null, max_tokens: null },
    security: { allowed_repo_roots: [dir], require_git_for_writes: true, allow_external_directories: false, read_sandbox: "auto" },
    opencode: { binary: "opencode", compatibility: "2.1.x", startup_timeout_ms: 5000 },
    history: { default_limit: 20, max_limit: 100, max_payload_chars: 4000, max_delegation_chars: 50_000 },
    mock: { scenario: "success", delay_ms: 5 },
  };
}

async function runTask(adapter: AgentAdapter, dir: string) {
  const services = createServices(config(dir), adapter, createLogger("silent"));
  const repo = await makeGitRepo(dir, `repo-${Date.now()}-${Math.random()}`);
  const spawned = await services.service.spawn({
    task: "cleanup test",
    repo_root: repo,
    task_type: "coding",
    model: "mock/echo",
    read_only: false,
    timeout_seconds: 10,
  });
  const finished = await services.manager.waitForTerminal(spawned.task.task_id, 5000);
  return { services, repo, task: finished };
}

describe("cleanup and approvals", () => {
  it("requires a local approval before deleting a dirty worktree", async () => {
    const dir = await realpath(await makeTempDir());
    try {
      const { services, task } = await runTask(new WritableTestAdapter(true), dir);
      const worktree = task?.worktree_path;
      expect(worktree).not.toBeNull();
      if (worktree === null || worktree === undefined || task === null || task === undefined) {
        throw new Error("missing worktree");
      }

      const plan = await services.service.cleanup({
        dry_run: true,
        include_worktrees: true,
        include_logs: false,
      });
      const planned = plan.actions.find((action) => action.path === worktree);
      expect(planned?.status).toBe("approval_required");
      expect(planned?.approval_id).toBeUndefined();

      const executed = await services.service.cleanup({
        dry_run: false,
        include_worktrees: true,
        include_logs: false,
      });
      const approvalAction = executed.actions.find((action) => action.path === worktree);
      expect(approvalAction?.status).toBe("approval_required");
      expect(approvalAction?.approval_id).toBeDefined();

      const approvalId = approvalAction?.approval_id;
      if (approvalId === undefined) throw new Error("missing approval");
      const approved = await services.service.approveCleanup(approvalId);
      expect(approved.actions[0]?.status).toBe("removed");
      await expect(stat(worktree)).rejects.toBeTruthy();

      const patchFiles = await readdir(join(dir, "data", "approvals"));
      expect(patchFiles).toContain(`${approvalId}.patch`);

      await expect(services.service.approveCleanup(approvalId)).rejects.toMatchObject({
        code: "APPROVAL_CONSUMED",
      });
      await services.manager.shutdown();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("removes clean worktrees and expired logs without approval", async () => {
    const dir = await realpath(await makeTempDir());
    try {
      const { services, task } = await runTask(new WritableTestAdapter(false), dir);
      expect(task?.worktree_path).not.toBeNull();
      const worktree = task?.worktree_path;
      if (worktree === null || worktree === undefined) throw new Error("missing worktree");

      const logDir = join(dir, "data", "logs");
      await mkdir(logDir, { recursive: true });
      const oldLog = join(logDir, "opencode-old.log");
      const recentLog = join(logDir, "opencode-recent.log");
      const daemonLog = join(logDir, "daemon.log");
      await writeFile(oldLog, "old\n");
      await writeFile(recentLog, "recent\n");
      await writeFile(daemonLog, "daemon\n");
      const old = new Date(Date.now() - 31 * 86_400_000);
      await utimes(oldLog, old, old);
      await utimes(daemonLog, old, old);

      const result = await services.service.cleanup({
        task_ids: [task?.task_id ?? ""],
        dry_run: false,
        include_worktrees: true,
        include_logs: true,
      });
      expect(result.actions.some((action) => action.kind === "worktree" && action.status === "removed")).toBe(true);
      expect(await readdir(logDir)).toContain("opencode-recent.log");
      expect(await readdir(logDir)).toContain("daemon.log");
      await expect(stat(oldLog)).rejects.toBeTruthy();
      await expect(stat(worktree)).rejects.toBeTruthy();
      await services.manager.shutdown();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
