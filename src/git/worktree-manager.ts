import { execFile } from "node:child_process";
import { chmod, mkdir } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { BridgeError } from "../errors.js";
import type { Logger } from "../logging.js";
import type { TaskRecord } from "../types.js";

const execFileAsync = promisify(execFile);

export interface WorktreeCreateResult {
  path: string;
  git_dir: string;
  base_commit: string;
  main_worktree_dirty: boolean;
  main_worktree_changes: string[];
}

export interface WorktreeDirtyStatus {
  dirty: boolean;
  files: string[];
}

export interface WorktreeRemoveResult {
  removed: boolean;
  reason?: "dirty" | "not_found" | "unsafe";
  files?: string[];
}

export class WorktreeManager {
  private readonly dataDir: string;
  private readonly logger: Logger;

  constructor(options: { dataDir: string; logger: Logger }) {
    this.dataDir = options.dataDir;
    this.logger = options.logger;
  }

  async create(task: TaskRecord): Promise<WorktreeCreateResult> {
    const baseCommit = task.base_commit ?? (await gitHead(task.repo_root));
    if (baseCommit === null) {
      throw new BridgeError(
        "WORKTREE_CREATE_FAILED",
        `Repository has no HEAD commit: ${task.repo_root}`,
        { details: { task_id: task.id, repo_root: task.repo_root } },
      );
    }

    const root = join(this.dataDir, "worktrees");
    await mkdir(root, { recursive: true, mode: 0o700 });
    const worktreePath = join(root, task.id);
    if (!isWithin(root, worktreePath)) {
      throw new BridgeError("WORKTREE_CREATE_FAILED", "Unsafe worktree path");
    }

    try {
      await git(task.repo_root, ["worktree", "add", "--detach", worktreePath, baseCommit]);
      await chmod(worktreePath, 0o700);
    } catch (error) {
      throw new BridgeError("WORKTREE_CREATE_FAILED", "Failed to create Git worktree", {
        cause: error,
        details: { task_id: task.id, repo_root: task.repo_root, worktree_path: worktreePath },
      });
    }

    const gitDirResult = await git(worktreePath, ["rev-parse", "--absolute-git-dir"]).catch(() => null);
    if (gitDirResult === null || gitDirResult.stdout.trim() === "") {
      throw new BridgeError("WORKTREE_CREATE_FAILED", "Could not resolve worktree Git directory", {
        details: { task_id: task.id, worktree_path: worktreePath },
      });
    }
    const gitDir = gitDirResult.stdout.trim();
    const mainStatus = await this.dirtyStatus(task.repo_root);
    this.logger.info(
      {
        task_id: task.id,
        worktree_path: worktreePath,
        base_commit: baseCommit,
        main_worktree_dirty: mainStatus.dirty,
      },
      "worktree created",
    );

    return {
      path: worktreePath,
      git_dir: gitDir,
      base_commit: baseCommit,
      main_worktree_dirty: mainStatus.dirty,
      main_worktree_changes: mainStatus.files,
    };
  }

  async dirtyStatus(worktreePath: string): Promise<WorktreeDirtyStatus> {
    try {
      const { stdout } = await git(worktreePath, ["status", "--porcelain=v1", "-z"]);
      const files = parsePorcelain(stdout);
      return { dirty: files.length > 0, files };
    } catch (error) {
      throw new BridgeError("WORKTREE_CREATE_FAILED", "Failed to inspect worktree status", {
        cause: error,
        details: { worktree_path: worktreePath },
      });
    }
  }

  async remove(worktreePath: string, repoRoot: string): Promise<WorktreeRemoveResult> {
    const root = join(this.dataDir, "worktrees");
    if (!isWithin(root, worktreePath)) {
      return { removed: false, reason: "unsafe" };
    }

    const status = await this.dirtyStatus(worktreePath).catch(() => null);
    if (status === null) return { removed: false, reason: "not_found" };
    if (status.dirty) {
      return { removed: false, reason: "dirty", files: status.files };
    }

    try {
      await git(repoRoot, ["worktree", "remove", worktreePath]);
      await git(repoRoot, ["worktree", "prune"]).catch(() => undefined);
      return { removed: true };
    } catch (error) {
      throw new BridgeError("WORKTREE_CREATE_FAILED", "Failed to remove Git worktree", {
        cause: error,
        details: { worktree_path: worktreePath, repo_root: repoRoot },
      });
    }
  }

  relativePath(worktreePath: string, file: string): string {
    return relative(worktreePath, file).split(sep).join("/");
  }
}

export function parsePorcelain(output: string): string[] {
  const entries = output.split("\0");
  const files: string[] = [];

  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];
    if (entry === undefined || entry.length < 4) continue;
    const status = entry.slice(0, 2);
    const file = entry.slice(3);
    files.push(file);
    if (status.includes("R") || status.includes("C")) {
      const renamed = entries[index + 1];
      if (renamed !== undefined && renamed !== "") files.push(renamed);
      index++;
    }
  }
  return files;
}

async function gitHead(repoRoot: string): Promise<string | null> {
  try {
    const { stdout } = await git(repoRoot, ["rev-parse", "HEAD"]);
    const value = stdout.trim();
    return value === "" ? null : value;
  } catch {
    return null;
  }
}

async function git(cwd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync("git", ["-C", cwd, ...args], {
    timeout: 30_000,
    maxBuffer: 10 * 1024 * 1024,
  });
}

function isWithin(root: string, candidate: string): boolean {
  const resolvedRoot = resolve(root) + sep;
  const resolvedCandidate = resolve(candidate);
  return resolvedCandidate === resolve(root) || resolvedCandidate.startsWith(resolvedRoot);
}
