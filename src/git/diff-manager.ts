import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { BridgeError } from "../errors.js";

export interface DiffFile {
  path: string;
  status: string;
  additions: number;
  deletions: number;
  untracked: boolean;
}

export interface DiffResult {
  available: boolean;
  worktree_path: string | null;
  base_commit: string | null;
  git_status: string;
  files: DiffFile[];
  added: string[];
  modified: string[];
  deleted: string[];
  untracked: string[];
  additions: number;
  deletions: number;
  patch: string;
  patch_truncated: boolean;
}

export interface DiffOptions {
  worktreePath: string;
  baseCommit: string;
  file?: string;
  maxChars?: number;
}

export class DiffManager {
  async getDiff(options: DiffOptions): Promise<DiffResult> {
    const maxChars = options.maxChars ?? 40_000;
    const file = options.file;
    const statusText = await git(options.worktreePath, ["status", "--porcelain=v1"]);
    const statusLines = statusText.stdout.split("\n").filter((line) => line.length > 0);

    const tracked = await git(options.worktreePath, [
      "diff",
      "--name-status",
      options.baseCommit,
      "--",
      ...(file === undefined ? [] : [file]),
    ]);
    const numstat = await git(options.worktreePath, [
      "diff",
      "--numstat",
      options.baseCommit,
      "--",
      ...(file === undefined ? [] : [file]),
    ]);
    const patchResult = await git(options.worktreePath, [
      "diff",
      "--no-ext-diff",
      options.baseCommit,
      "--",
      ...(file === undefined ? [] : [file]),
    ]);

    const untrackedResult = await git(options.worktreePath, [
      "ls-files",
      "--others",
      "--exclude-standard",
      ...(file === undefined ? [] : ["--", file]),
    ]);
    const untracked = untrackedResult.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "");

    const fileMap = new Map<string, DiffFile>();

    for (const line of tracked.stdout.split("\n")) {
      if (line.trim() === "") continue;
      const [statusRaw, ...paths] = line.split("\t");
      if (statusRaw === undefined || paths.length === 0) continue;
      const status = statusRaw.charAt(0);
      const path = paths.at(-1) ?? paths[0];
      if (path === undefined) continue;
      fileMap.set(path, {
        path,
        status,
        additions: 0,
        deletions: 0,
        untracked: false,
      });
    }

    for (const line of numstat.stdout.split("\n")) {
      if (line.trim() === "") continue;
      const [added, deleted, ...pathParts] = line.split("\t");
      const path = pathParts.join("\t");
      if (path === "") continue;
      const existing = fileMap.get(path);
      if (existing === undefined) continue;
      existing.additions = Number(added) || 0;
      existing.deletions = Number(deleted) || 0;
    }

    for (const path of untracked) {
      if (file !== undefined && path !== file) continue;
      fileMap.set(path, {
        path,
        status: "??",
        additions: await countLines(join(options.worktreePath, path)),
        deletions: 0,
        untracked: true,
      });
    }

    const files = [...fileMap.values()].sort((a, b) => a.path.localeCompare(b.path));
    const added = files.filter((entry) => entry.status === "A" || entry.status === "??").map((entry) => entry.path);
    const modified = files.filter((entry) => entry.status === "M").map((entry) => entry.path);
    const deleted = files.filter((entry) => entry.status === "D").map((entry) => entry.path);
    const additions = files.reduce((sum, entry) => sum + entry.additions, 0);
    const deletions = files.reduce((sum, entry) => sum + entry.deletions, 0);

    let patch = patchResult.stdout;
    const untrackedPatches: string[] = [];
    for (const path of untracked.slice(0, 20)) {
      if (file !== undefined && path !== file) continue;
      const result = await git(
        options.worktreePath,
        ["diff", "--no-index", "--no-ext-diff", "--", "/dev/null", path],
        true,
      );
      if (result.stdout !== "") untrackedPatches.push(result.stdout);
    }
    if (untrackedPatches.length > 0) {
      patch = `${patch}${patch === "" ? "" : "\n"}${untrackedPatches.join("\n")}`;
    }

    const truncated = patch.length > maxChars;
    if (truncated) {
      patch = `${patch.slice(0, maxChars)}\n...[diff truncated at ${maxChars} characters]`;
    }

    return {
      available: true,
      worktree_path: options.worktreePath,
      base_commit: options.baseCommit,
      git_status: statusLines.slice(0, 200).join("\n"),
      files,
      added,
      modified,
      deleted,
      untracked,
      additions,
      deletions,
      patch,
      patch_truncated: truncated,
    };
  }
}

async function countLines(path: string): Promise<number> {
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size > 1_000_000) return 0;
    const { readFile } = await import("node:fs/promises");
    const text = await readFile(path, "utf8");
    return text === "" ? 0 : text.split("\n").length;
  } catch {
    return 0;
  }
}

function git(
  cwd: string,
  args: string[],
  allowFailure = false,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      ["-C", cwd, ...args],
      { timeout: 30_000, maxBuffer: 10 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error !== null && !allowFailure) {
          reject(
            new BridgeError("WORKTREE_CREATE_FAILED", `Git command failed: git ${args.join(" ")}`, {
              cause: error,
              details: { cwd, args, stderr },
            }),
          );
          return;
        }
        const code = error === null ? 0 : typeof error.code === "number" ? error.code : 1;
        resolve({ code, stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}
