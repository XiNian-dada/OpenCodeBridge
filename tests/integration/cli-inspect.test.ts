import { execFile } from "node:child_process";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config.js";
import { IpcTaskClient } from "../../src/daemon/client.js";
import { ensureDaemon } from "../../src/daemon/ensure.js";
import { daemonPaths, readDaemonState } from "../../src/daemon/state.js";
import { createLogger } from "../../src/logging.js";
import { makeGitRepo } from "../helpers/fixtures.js";

const execFileAsync = promisify(execFile);

async function cli(configPath: string, args: string[]) {
  const result = await execFileAsync(
    process.execPath,
    ["--import", "tsx", "src/cli/index.ts", ...args],
    { cwd: process.cwd(), env: { ...process.env, BRIDGE_CONFIG: configPath } },
  );
  return result.stdout;
}

describe("bridge CLI task inspection", () => {
  it("lists, reads status, logs, and diff for a daemon task", async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), "cob-cli-inspect-")));
    const repo = await makeGitRepo(dir);
    const configPath = join(dir, "config.json");
    await writeFile(
      configPath,
      JSON.stringify(
        {
          adapter: "mock",
          log_level: "silent",
          data_dir: join(dir, "data"),
          models: { default: "mock/echo", allow: ["mock/echo"] },
          security: { allowed_repo_roots: [dir], require_git_for_writes: true },
          mock: { scenario: "success", delay_ms: 5 },
        },
        null,
        2,
      ),
      "utf8",
    );
    const config = loadConfig({ path: configPath, env: {} });
    const paths = daemonPaths(config);
    let daemon: IpcTaskClient | null = null;
    try {
      daemon = await ensureDaemon({ config, configPath, logger: createLogger("silent") });
      const spawned = await daemon.spawn({
        task: "CLI inspection task",
        repo_root: repo,
        task_type: "analysis",
        model: "mock/echo",
        read_only: true,
        timeout_seconds: 10,
      });
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const view = await daemon.status(spawned.task.task_id);
        if (view.status === "completed") break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      daemon.close();
      daemon = null;

      const tasks = JSON.parse(await cli(configPath, ["tasks", "--json"])) as {
        tasks: Array<Record<string, unknown>>;
      };
      expect(tasks.tasks.some((task) => task.task_id === spawned.task.task_id)).toBe(true);

      const status = JSON.parse(
        await cli(configPath, ["status", spawned.task.task_id, "--json"]),
      ) as { task: Record<string, unknown> };
      expect(status.task.status).toBe("completed");

      const logs = await cli(configPath, ["logs", spawned.task.task_id, "--json"]);
      expect(logs.split("\n").filter(Boolean).length).toBeGreaterThan(0);

      const diff = JSON.parse(
        await cli(configPath, ["diff", spawned.task.task_id, "--json"]),
      ) as { available: boolean };
      expect(diff.available).toBe(false);
    } finally {
      daemon?.close();
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
