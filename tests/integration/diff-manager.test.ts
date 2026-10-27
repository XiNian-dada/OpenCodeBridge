import { execFile } from "node:child_process";
import { realpath, rm, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { DiffManager } from "../../src/git/diff-manager.js";
import { WorktreeManager } from "../../src/git/worktree-manager.js";
import { createLogger } from "../../src/logging.js";
import type { TaskRecord } from "../../src/types.js";
import { emptyUsage } from "../../src/types.js";
import { makeGitRepo, makeTempDir } from "../helpers/fixtures.js";

const execFileAsync = promisify(execFile);

function task(repoRoot: string, baseCommit: string): TaskRecord {
  return {
    id: "task_diff_test",
    parent_task_id: null,
    root_task_id: "task_diff_test",
    turn: 1,
    opencode_task_id: "task_diff_test",
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
    server_pid: null,
    worktree_path: null,
    worktree_git_dir: null,
    base_commit: baseCommit,
    context_path: null,
    workspace_path: null,
    context_files: [],
    read_paths: [],
    write_paths: [],
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

describe("DiffManager", () => {
  it("reports modified, deleted, added, and untracked files with a patch", async () => {
    const dir = await realpath(await makeTempDir());
    try {
      const repo = await makeGitRepo(dir);
      await writeFile(join(repo, "delete-me.txt"), "old\n", "utf8");
      await execFileAsync("git", ["-C", repo, "add", "delete-me.txt"]);
      await execFileAsync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "extra"]);
      const base = (await execFileAsync("git", ["-C", repo, "rev-parse", "HEAD"])).stdout.trim();

      const worktrees = new WorktreeManager({ dataDir: join(dir, "data"), logger: createLogger("silent") });
      const created = await worktrees.create(task(repo, base));

      await writeFile(join(created.path, "README.md"), "# changed\n", "utf8");
      await unlink(join(created.path, "delete-me.txt"));
      await writeFile(join(created.path, "staged.txt"), "staged\n", "utf8");
      await execFileAsync("git", ["-C", created.path, "add", "staged.txt"]);
      await writeFile(join(created.path, "untracked.txt"), "one\ntwo\n", "utf8");

      const diff = await new DiffManager().getDiff({
        worktreePath: created.path,
        baseCommit: base,
      });

      expect(diff.available).toBe(true);
      expect(diff.modified).toContain("README.md");
      expect(diff.deleted).toContain("delete-me.txt");
      expect(diff.added).toContain("staged.txt");
      expect(diff.untracked).toContain("untracked.txt");
      expect(diff.additions).toBeGreaterThan(0);
      expect(diff.patch).toContain("changed");
      expect(diff.patch).toContain("untracked.txt");
      expect(diff.patch_truncated).toBe(false);
      expect(diff.files.find((entry) => entry.path === "untracked.txt")?.additions).toBe(2);
      expect(diff.full_patch_sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(diff.full_patch_bytes).toBe(Buffer.byteLength(diff.patch));
      expect(diff.complete_file_count).toBe(diff.files.length);
      expect(diff.returned_file_count).toBe(diff.files.length);
      expect(diff.omitted_files).toEqual([]);
      expect(diff.truncation_reason).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("supports per-file queries and patch truncation", async () => {
    const dir = await realpath(await makeTempDir());
    try {
      const repo = await makeGitRepo(dir);
      const base = (await execFileAsync("git", ["-C", repo, "rev-parse", "HEAD"])).stdout.trim();
      const worktrees = new WorktreeManager({ dataDir: join(dir, "data"), logger: createLogger("silent") });
      const created = await worktrees.create(task(repo, base));
      await writeFile(join(created.path, "README.md"), "# changed\nsecond line\n", "utf8");
      await writeFile(join(created.path, "other.txt"), "other\n", "utf8");

      const diff = await new DiffManager().getDiff({
        worktreePath: created.path,
        baseCommit: base,
        file: "README.md",
        maxChars: 20,
      });

      expect(diff.files.map((file) => file.path)).toEqual(["README.md"]);
      expect(diff.patch_truncated).toBe(true);
      expect(diff.patch).toContain("diff truncated");
      expect(diff.full_patch_sha256).toMatch(/^[0-9a-f]{64}$/);

      const full = await new DiffManager().getDiff({
        worktreePath: created.path,
        baseCommit: base,
        file: "README.md",
        maxChars: 200_000,
      });
      expect(full.full_patch_sha256).toBe(diff.full_patch_sha256);
      expect(full.patch_truncated).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("reports untracked patch omissions instead of silently truncating the file list", async () => {
    const dir = await realpath(await makeTempDir());
    try {
      const repo = await makeGitRepo(dir);
      const base = (await execFileAsync("git", ["-C", repo, "rev-parse", "HEAD"])).stdout.trim();
      const worktrees = new WorktreeManager({ dataDir: join(dir, "data"), logger: createLogger("silent") });
      const created = await worktrees.create(task(repo, base));
      for (let index = 1; index <= 21; index++) {
        await writeFile(
          join(created.path, `new-${String(index).padStart(2, "0")}.txt`),
          `file ${index}\n`,
          "utf8",
        );
      }

      const diff = await new DiffManager().getDiff({
        worktreePath: created.path,
        baseCommit: base,
      });

      expect(diff.files).toHaveLength(21);
      expect(diff.complete_file_count).toBe(21);
      expect(diff.returned_file_count).toBe(20);
      expect(diff.omitted_files).toEqual(["new-21.txt"]);
      expect(diff.patch_truncated).toBe(true);
      expect(diff.truncation_reason).toBe("untracked_limit");
      expect(diff.patch).not.toContain("file 21");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
