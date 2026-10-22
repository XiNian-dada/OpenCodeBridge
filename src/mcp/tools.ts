import type { McpServer } from "@modelcontextprotocol/server";
import type { BridgeServices } from "../app.js";
import { toErrorPayload } from "../errors.js";
import type { TaskView } from "../types.js";
import {
  AgentAbortInput,
  AgentHistoryInput,
  AgentListInput,
  AgentSpawnInput,
  AgentStatusInput,
} from "./schemas.js";

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  structuredContent: Record<string, unknown>;
  isError?: boolean;
};

function success(payload: Record<string, unknown>): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    structuredContent: payload,
  };
}

function failure(error: unknown): ToolResult {
  const payload = { ok: false as const, error: toErrorPayload(error) };
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    structuredContent: payload,
    isError: true,
  };
}

function taskPayload(task: TaskView): Record<string, unknown> {
  return task as unknown as Record<string, unknown>;
}

export function registerAgentTools(server: McpServer, services: BridgeServices): void {
  const { manager, config } = services;

  server.registerTool(
    "agent_spawn",
    {
      title: "Spawn an OpenCode task",
      description:
        "Create and enqueue an asynchronous coding task. Returns a task ID immediately; poll agent_status for progress.",
      inputSchema: AgentSpawnInput,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
      },
    },
    async (input) => {
      try {
        const result = await manager.spawn({
          task: input.task,
          repo_root: input.repo_root,
          task_type: input.task_type,
          ...(input.model === undefined ? {} : { model: input.model }),
          read_only: input.read_only,
          timeout_seconds: input.timeout_seconds ?? config.scheduler.default_timeout_seconds,
          ...(input.idempotency_key === undefined
            ? {}
            : { idempotency_key: input.idempotency_key }),
        });
        return success({
          ok: true,
          task: taskPayload(result.task),
          deduplicated: result.deduplicated,
        });
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "agent_status",
    {
      title: "Get task status",
      description: "Read one task's persisted status without invoking a model.",
      inputSchema: AgentStatusInput,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async (input) => {
      try {
        return success({ ok: true, task: taskPayload(manager.status(input.task_id)) });
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "agent_history",
    {
      title: "Read task history",
      description:
        "Read the delegated task, prompt sent to the agent, agent messages, and tool events. Defaults to recent events.",
      inputSchema: AgentHistoryInput,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async (input) => {
      try {
        const limit = Math.min(
          input.limit ?? config.history.default_limit,
          config.history.max_limit,
        );
        const result = manager.history(input.task_id, {
          limit,
          ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
          ...(input.event_types === undefined ? {} : { types: input.event_types }),
        });
        return success({
          ok: true,
          task: result.task as unknown as Record<string, unknown>,
          events: result.events as unknown as Array<Record<string, unknown>>,
          next_cursor: result.next_cursor,
          has_more: result.has_more,
          total_events: result.total,
        });
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "agent_abort",
    {
      title: "Abort a task",
      description:
        "Request cancellation of a queued or running task. The bridge verifies the adapter stopped before reporting success.",
      inputSchema: AgentAbortInput,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async (input) => {
      try {
        const result = await manager.abort(input.task_id);
        return success({
          ok: true,
          task: taskPayload(result.task),
          stopped: result.stopped,
          already_terminal: result.already_terminal,
        });
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "agent_list",
    {
      title: "List tasks",
      description: "List current and historical tasks, newest first.",
      inputSchema: AgentListInput,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async (input) => {
      try {
        const tasks = manager.list({
          ...(input.status === undefined ? {} : { status: input.status }),
          ...(input.repo_root === undefined ? {} : { repo_root: input.repo_root }),
          ...(input.model === undefined ? {} : { model: input.model }),
          limit: input.limit,
        });
        return success({
          ok: true,
          tasks: tasks.map((task) => taskPayload(task)),
          total: tasks.length,
        });
      } catch (error) {
        return failure(error);
      }
    },
  );
}
