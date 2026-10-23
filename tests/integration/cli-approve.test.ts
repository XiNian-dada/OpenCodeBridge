import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { daemonPaths, readDaemonState } from "../../src/daemon/state.js";
import { openSqliteStore } from "../../src/storage/sqlite-store.js";
import { makeGitRepo } from "../helpers/fixtures.js";
import { loadConfig } from "../../src/config.js";

const execFileAsync = promisify(execFile);

describe("independent cleanup approval CLI", () => {
  it("removes an approved worktree through the local CLI channel", async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), "cob-cli-approve-")));
    const repo = await makeGitRepo(dir);
    const configPath = join(dir, "config.json");
    const dataDir = join(dir, "data");
    await writeFile(
      configPath,
      JSON.stringify(
        {
          adapter: "mock",
          log_level: "silent",
          data_dir: dataDir,
          models: { default: "mock/echo", allow: ["mock/echo"] },
          security: { allowed_repo_roots: [dir], require_git_for_writes: true },
          cleanup: { log_retention_days: 30, worktree_retention_days: 0 },
          mock: { scenario: "success", delay_ms: 5 },
        },
        null,
        2,
      ),
      "utf8",
    );

    const worktree = join(dataDir, "worktrees", "task_manual_approval");
    await mkdir(join(dataDir, "worktrees"), { recursive: true });
    const base = (await execFileAsync("git", ["-C", repo, "rev-parse", "HEAD"])).stdout.trim();
    await execFileAsync("git", ["-C", repo, "worktree", "add", "--detach", worktree, base]);

    const config = loadConfig({ path: configPath, env: {} });
    const paths = daemonPaths(config);
    const store = openSqliteStore(paths.databasePath);
    store.saveApproval({
      id: "approval_cli_test",
      kind: "cleanup_worktree",
      payload: {
        task_id: "task_manual_approval",
        worktree_path: worktree,
        repo_root: repo,
        base_commit: base,
      },
      created_at: new Date().toISOString(),
      consumed_at: null,
    });
    store.close();

    try {
      const result = await execFileAsync(
        process.execPath,
        ["--import", "tsx", "src/cli/index.ts", "approve", "approval_cli_test"],
        {
          cwd: process.cwd(),
          env: { ...process.env, BRIDGE_CONFIG: configPath },
        },
      );
      expect(result.stdout).toContain('"removed"');
      await expect(execFileAsync("git", ["-C", repo, "worktree", "list"])).resolves.toBeTruthy();
      await expect(execFileAsync("test", ["-d", worktree])).rejects.toBeTruthy();
    } finally {
      const state = await readDaemonState(paths.statePath);
      if (state !== null) {
        try {
          process.kill(-state.pid, "SIGTERM");
        } catch {
          try {
            process.kill(state.pid, "SIGTERM");
          } catch {
            // gone
          }
        }
      }
      await rm(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
