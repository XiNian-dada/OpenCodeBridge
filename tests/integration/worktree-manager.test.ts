import { execFile } from "node:child_process";
import { realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { WorktreeManager } from "../../src/git/worktree-manager.js";
import { createLogger } from "../../src/logging.js";
import type { TaskRecord } from "../../src/types.js";
import { emptyUsage } from "../../src/types.js";
import { makeGitRepo, makeTempDir } from "../helpers/fixtures.js";

const execFileAsync = promisify(execFile);

function task(repoRoot: string, baseCommit: string | null, id = "task_worktree_test"): TaskRecord {
  return {
    id,
    idempotency_key: null,
    idempotency_fingerprint: null,
    task: "test",
    repo_root: repoRoot,
    task_type: "coding",
    model: "mock/echo",
    provider_id: "mock",
    model_id: "echo",
    model_variant: null,
    read_only: false,
    timeout_seconds: 30,
    status: "preparing",
    stage: "preparing",
    session_id: null,
    worktree_path: null,
    base_commit: baseCommit,
    created_at: new Date().toISOString(),
    started_at: null,
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

describe("WorktreeManager", () => {
  it("creates a detached worktree and reports dirty main workspace", async () => {
    const dir = await realpath(await makeTempDir());
    try {
      const repo = await makeGitRepo(dir);
      await writeFile(join(repo, "dirty.txt"), "not committed\n", "utf8");
      const head = (await execFileAsync("git", ["-C", repo, "rev-parse", "HEAD"])).stdout.trim();
      const manager = new WorktreeManager({ dataDir: join(dir, "data"), logger: createLogger("silent") });

      const created = await manager.create(task(repo, head));
      expect(created.path).toContain(join("data", "worktrees", "task_worktree_test"));
      expect(created.base_commit).toBe(head);
      expect(created.main_worktree_dirty).toBe(true);
      expect(created.main_worktree_changes).toContain("dirty.txt");

      const status = await manager.dirtyStatus(created.path);
      expect(status.dirty).toBe(false);
      expect((await manager.remove(created.path, repo)).removed).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("refuses to remove a dirty worktree", async () => {
    const dir = await realpath(await makeTempDir());
    try {
      const repo = await makeGitRepo(dir);
      const head = (await execFileAsync("git", ["-C", repo, "rev-parse", "HEAD"])).stdout.trim();
      const manager = new WorktreeManager({ dataDir: join(dir, "data"), logger: createLogger("silent") });
      const created = await manager.create(task(repo, head));

      await writeFile(join(created.path, "work.txt"), "unreviewed\n", "utf8");
      const removed = await manager.remove(created.path, repo);
      expect(removed.removed).toBe(false);
      expect(removed.reason).toBe("dirty");
      expect(removed.files).toContain("work.txt");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects repositories without a HEAD commit", async () => {
    const dir = await realpath(await makeTempDir());
    try {
      const repo = join(dir, "empty");
      await execFileAsync("git", ["-C", dir, "init", "-q"]);
      await execFileAsync("git", ["init", "-q", repo]);
      const manager = new WorktreeManager({ dataDir: join(dir, "data"), logger: createLogger("silent") });
      await expect(manager.create(task(repo, null))).rejects.toMatchObject({
        code: "WORKTREE_CREATE_FAILED",
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
