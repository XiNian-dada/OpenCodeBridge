import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config.js";
import { IpcTaskClient } from "../../src/daemon/client.js";
import { ensureDaemon } from "../../src/daemon/ensure.js";
import { daemonPaths, readDaemonState } from "../../src/daemon/state.js";
import { createLogger } from "../../src/logging.js";
import { makeGitRepo } from "../helpers/fixtures.js";

async function waitFor(
  predicate: () => Promise<boolean>,
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Timed out waiting for condition");
}

describe("bridge daemon", () => {
  it("survives client disconnects and serves persisted tasks", async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), "cob-daemon-test-")));
    const repo = await makeGitRepo(dir);
    const configPath = join(dir, "config.json");
    await writeFile(
      configPath,
      JSON.stringify(
        {
          adapter: "mock",
          log_level: "silent",
          data_dir: join(dir, "data"),
          scheduler: {
            max_concurrent: 1,
            max_queue: 5,
            default_timeout_seconds: 30,
            max_timeout_seconds: 60,
          },
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
    let client: IpcTaskClient | null = null;
    try {
      client = await ensureDaemon({
        config,
        configPath,
        logger: createLogger("silent"),
        startupTimeoutMs: 15_000,
      });
      const spawned = await client.spawn({
        task: "daemon persistence test",
        repo_root: repo,
        task_type: "analysis",
        model: "mock/echo",
        read_only: true,
        timeout_seconds: 10,
      });
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const view = await client.status(spawned.task.task_id);
        if (view.status === "completed") break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }

      client.close();
      client = await IpcTaskClient.connect(paths.socketPath);
      const reloaded = await client.status(spawned.task.task_id);
      expect(reloaded.status).toBe("completed");
      const viewer = await client.viewer();
      expect(viewer.auto_open).toBe(false);
      const viewerUrl = new URL(viewer.url!);
      const viewerHeaders = { authorization: `Bearer ${new URLSearchParams(viewerUrl.hash.slice(1)).get("key")}` };
      const viewerTasks = await (await fetch(`${viewerUrl.origin}/api/tasks`, { headers: viewerHeaders })).json() as { tasks: Array<{ task_id: string }> };
      expect(viewerTasks.tasks[0]?.task_id).toBe(spawned.task.task_id);
      const history = await client.history(spawned.task.task_id, { limit: 100 });
      expect(history.events.map((event) => event.event_type)).toContain("task.completed");

      const socketMode = (await import("node:fs/promises").then((fs) => fs.stat(paths.socketPath))).mode;
      expect(socketMode & 0o777).toBe(0o600);
      const state = await readDaemonState(paths.statePath);
      expect(state?.pid).toBeGreaterThan(0);
      const stateMode = (await import("node:fs/promises").then((fs) => fs.stat(paths.statePath))).mode;
      expect(stateMode & 0o777).toBe(0o600);

      await client.shutdownDaemon();
      await waitFor(async () => {
        try {
          await readFile(paths.statePath);
          return false;
        } catch {
          return true;
        }
      });
    } finally {
      client?.close();
      const state = await readDaemonState(paths.statePath);
      if (state !== null) {
        try {
          process.kill(-state.pid, "SIGTERM");
        } catch {
          try {
            process.kill(state.pid, "SIGTERM");
          } catch {
            // already gone
          }
        }
      }
      await rm(dir, { recursive: true, force: true });
    }
  }, 30_000);
  it("marks in-flight tasks interrupted after a daemon crash", async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), "cob-daemon-crash-")));
    const repo = await makeGitRepo(dir);
    const configPath = join(dir, "config.json");
    await writeFile(
      configPath,
      JSON.stringify(
        {
          adapter: "mock",
          log_level: "silent",
          data_dir: join(dir, "data"),
          scheduler: { max_concurrent: 1, max_queue: 5, default_timeout_seconds: 30 },
          models: { default: "mock/echo", allow: ["mock/echo"] },
          security: { allowed_repo_roots: [dir], require_git_for_writes: true },
          mock: { scenario: "slow", delay_ms: 5 },
        },
        null,
        2,
      ),
      "utf8",
    );

    const config = loadConfig({ path: configPath, env: {} });
    const paths = daemonPaths(config);
    let client: IpcTaskClient | null = null;
    try {
      client = await ensureDaemon({ config, configPath, logger: createLogger("silent") });
      const spawned = await client.spawn({
        task: "crash recovery test",
        repo_root: repo,
        task_type: "analysis",
        model: "mock/echo",
        read_only: true,
        timeout_seconds: 30,
      });
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline) {
        const view = await client.status(spawned.task.task_id);
        if (view.status === "running") break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      const oldState = await readDaemonState(paths.statePath);
      expect(oldState).not.toBeNull();
      if (oldState !== null) {
        try {
          process.kill(-oldState.pid, "SIGKILL");
        } catch {
          process.kill(oldState.pid, "SIGKILL");
        }
      }
      client.close();
      client = null;
      await new Promise((resolve) => setTimeout(resolve, 200));

      client = await ensureDaemon({ config, configPath, logger: createLogger("silent") });
      const recovered = await client.status(spawned.task.task_id);
      expect(recovered.status).toBe("interrupted");
      expect(recovered.error?.code).toBe("SESSION_LOST");
      const history = await client.history(spawned.task.task_id, { limit: 100 });
      const events = history.events.map((event) => event.event_type);
      expect(events).toContain("task.interrupted");
      expect(events).not.toContain("task.completed");
    } finally {
      client?.close();
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
