import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { describe, expect, it } from "vitest";
import { createHarness, spawnInput, type Harness } from "../helpers/fixtures.js";

interface DecodedToolResult {
  json: Record<string, unknown>;
  isError: boolean;
}

interface McpHandle {
  client: Client;
  stderr: string[];
  close(): Promise<void>;
}

function decodeToolResult(result: unknown): DecodedToolResult {
  const raw = result as {
    structuredContent?: Record<string, unknown>;
    content?: Array<{ type: string; text?: string }>;
    isError?: boolean;
  };

  if (raw.structuredContent !== undefined) {
    return { json: raw.structuredContent, isError: raw.isError === true };
  }

  const text = raw.content?.find((item) => item.type === "text")?.text;
  if (text === undefined) throw new Error("Tool result had no text or structured content");
  return { json: JSON.parse(text) as Record<string, unknown>, isError: raw.isError === true };
}

async function callTool(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<DecodedToolResult> {
  return decodeToolResult(await client.callTool({ name, arguments: args }));
}

async function startMcp(configPath: string, scenario: string): Promise<McpHandle> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", "src/mcp/server.ts"],
    cwd: process.cwd(),
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      BRIDGE_CONFIG: configPath,
      BRIDGE_MOCK_SCENARIO: scenario,
      BRIDGE_MOCK_DELAY_MS: "5",
    },
    stderr: "pipe",
  });

  const stderr: string[] = [];
  transport.stderr?.on("data", (chunk: Buffer | string) => {
    stderr.push(String(chunk));
  });

  const client = new Client({ name: "bridge-test", version: "1.0.0" });
  await client.connect(transport);

  return {
    client,
    stderr,
    async close() {
      await client.close();
    },
  };
}

async function waitForTaskStatus(
  client: Client,
  taskId: string,
  desired: string[],
  timeoutMs = 5000,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { json } = await callTool(client, "agent_status", { task_id: taskId });
    const task = json.task as Record<string, unknown> | undefined;
    if (task !== undefined && desired.includes(String(task.status))) return task;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for task ${taskId} to reach ${desired.join(", ")}`);
}

async function closeHarness(harness: Harness): Promise<void> {
  await harness.cleanup();
}

describe("MCP stdio server with mock adapter", () => {
  it("exposes tools and completes an auditable task lifecycle", async () => {
    const harness = await createHarness();
    let mcp: McpHandle | null = null;
    try {
      mcp = await startMcp(harness.configPath, "success");

      const tools = await mcp.client.listTools();
      const names = tools.tools.map((tool) => tool.name);
      expect(names).toEqual(
        expect.arrayContaining([
          "agent_spawn",
          "agent_status",
          "agent_history",
          "agent_diff",
          "agent_abort",
          "agent_list",
        ]),
      );

      const spawnArgs = {
        ...spawnInput(harness.repoRoot),
        idempotency_key: "mcp-idempotency",
      };
      const spawned = await callTool(mcp.client, "agent_spawn", spawnArgs);
      expect(spawned.isError).toBe(false);
      expect(spawned.json.ok).toBe(true);
      const spawnedTask = spawned.json.task as Record<string, unknown>;
      const taskId = String(spawnedTask.task_id);
      expect(taskId).toMatch(/^task_/);

      const duplicate = await callTool(mcp.client, "agent_spawn", spawnArgs);
      expect(duplicate.json.deduplicated).toBe(true);
      expect((duplicate.json.task as Record<string, unknown>).task_id).toBe(taskId);

      const completed = await waitForTaskStatus(mcp.client, taskId, ["completed"]);
      expect(completed.status).toBe("completed");
      expect(completed.session_id).toMatch(/^mock_sess_/);

      const history = await callTool(mcp.client, "agent_history", {
        task_id: taskId,
        limit: 100,
      });
      expect(history.isError).toBe(false);
      const historyTask = history.json.task as Record<string, unknown>;
      expect(String(historyTask.task)).toContain("focused unit test");
      const events = history.json.events as Array<Record<string, unknown>>;
      const eventTypes = events.map((event) => String(event.event_type));
      expect(eventTypes).toContain("task.created");
      expect(eventTypes).toContain("prompt.sent");
      expect(eventTypes).toContain("tool.called");
      expect(eventTypes).toContain("task.completed");
      expect(history.json.total_events).toBeGreaterThan(0);

      const diff = await callTool(mcp.client, "agent_diff", { task_id: taskId });
      expect(diff.isError).toBe(false);
      expect(diff.json.available).toBe(false);
      expect(diff.json.reason).toBe("no_worktree");

      const listed = await callTool(mcp.client, "agent_list", { limit: 10 });
      expect((listed.json.tasks as unknown[]).length).toBe(1);

      const rejected = await callTool(mcp.client, "agent_spawn", {
        ...spawnInput(harness.repoRoot),
        model: "evil/model",
      });
      expect(rejected.isError).toBe(true);
      expect((rejected.json.error as Record<string, unknown>).code).toBe("MODEL_NOT_ALLOWED");
    } finally {
      if (mcp !== null) await mcp.close();
      await closeHarness(harness);
    }
  });

  it("aborts a running task through MCP and reports verified cancellation", async () => {
    const harness = await createHarness({ scenario: "slow" });
    let mcp: McpHandle | null = null;
    try {
      mcp = await startMcp(harness.configPath, "slow");
      const spawned = await callTool(mcp.client, "agent_spawn", spawnInput(harness.repoRoot));
      const taskId = String((spawned.json.task as Record<string, unknown>).task_id);

      await waitForTaskStatus(mcp.client, taskId, ["running"]);

      const aborted = await callTool(mcp.client, "agent_abort", { task_id: taskId });
      expect(aborted.isError).toBe(false);
      expect(aborted.json.stopped).toBe(true);
      expect((aborted.json.task as Record<string, unknown>).status).toBe("cancelled");
    } finally {
      if (mcp !== null) await mcp.close();
      await closeHarness(harness);
    }
  });
});
