import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config.js";
import { IpcTaskClient } from "../../src/daemon/client.js";
import { ensureDaemon } from "../../src/daemon/ensure.js";
import { daemonPaths, readDaemonState } from "../../src/daemon/state.js";
import { createLogger } from "../../src/logging.js";
import { makeGitRepo } from "../helpers/fixtures.js";

async function startMcp(configPath: string): Promise<{ client: Client; close(): Promise<void> }> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", "src/mcp/server.ts"],
    cwd: process.cwd(),
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      BRIDGE_CONFIG: configPath,
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "daemon-mcp-test", version: "1.0.0" });
  await client.connect(transport);
  return { client, close: () => client.close() };
}

async function waitForStatus(client: Client, taskId: string, status: string) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const result = await client.callTool({ name: "agent_status", arguments: { task_id: taskId } });
    const json = (result as { structuredContent?: Record<string, unknown> }).structuredContent;
    const task = json?.task as Record<string, unknown> | undefined;
    if (task?.status === status) return task;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${status}`);
}

describe("MCP server over daemon", () => {
  it("keeps task state after the MCP adapter reconnects", async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), "cob-mcp-daemon-")));
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
    let mcp: { client: Client; close(): Promise<void> } | null = null;
    try {
      daemon = await ensureDaemon({ config, configPath, logger: createLogger("silent") });
      mcp = await startMcp(configPath);
      const capabilities = await mcp.client.callTool({ name: "agent_capabilities", arguments: {} });
      expect(capabilities.structuredContent).toMatchObject({
        ok: true, capabilities: { adapter: "mock", simulated: true },
      });
      const preflight = await mcp.client.callTool({
        name: "agent_preflight",
        arguments: { repo_root: repo, read_only: true },
      });
      expect(preflight.structuredContent).toMatchObject({
        ok: true,
        preflight: {
          workspace: { kind: "repo_root", repo_root: repo },
          permissions: { edit: false, shell: false },
        },
      });
      const spawned = await mcp.client.callTool({
        name: "agent_spawn",
        arguments: {
          task: "survive MCP reconnect",
          repo_root: repo,
          task_type: "analysis",
          model: "mock/echo",
          read_only: true,
          timeout_seconds: 10,
        },
      });
      const task = (spawned as { structuredContent?: { task?: Record<string, unknown> } })
        .structuredContent?.task;
      const taskId = String(task?.task_id);
      const waited = await mcp.client.callTool({
        name: "agent_wait", arguments: { task_ids: [taskId], timeout_seconds: 3 },
      });
      expect(waited.structuredContent).toMatchObject({ ready_task_ids: [taskId], timed_out: false });
      await mcp.close();
      mcp = null;

      mcp = await startMcp(configPath);
      const after = await waitForStatus(mcp.client, taskId, "completed");
      expect(after.session_id).toMatch(/^mock_sess_/);
      const history = await mcp.client.callTool({
        name: "agent_history",
        arguments: { task_id: taskId, limit: 100 },
      });
      const historyJson = (history as { structuredContent?: Record<string, unknown> })
        .structuredContent as Record<string, unknown>;
      const events = historyJson.events as Array<Record<string, unknown>>;
      expect(events.map((event) => event.event_type)).toContain("task.completed");

      const delivery = await mcp.client.callTool({
        name: "agent_delivery",
        arguments: { task_id: taskId },
      });
      expect(delivery.structuredContent).toMatchObject({
        ok: true,
        delivery: { status: "completed", verification: { status: "simulated" } },
      });
    } finally {
      if (mcp !== null) await mcp.close();
      if (daemon !== null) {
        await daemon.shutdownDaemon().catch(() => undefined);
        daemon.close();
      }
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
