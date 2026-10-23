import * as z from "zod/v4";
import { TASK_STATUSES, TASK_TYPES } from "../types.js";

const taskId = z.string().min(1).describe("Bridge task ID (for example task_...)");

const repoRoot = z
  .string()
  .min(1)
  .describe("Absolute path to the target Git repository (or an allowed directory for read-only tasks)");

const taskType = z.enum(TASK_TYPES).describe("Task category");

export const AgentSpawnInput = z
  .object({
    task: z
      .string()
      .min(1)
      .max(100_000)
      .describe("Complete task instructions, including scope, constraints, and completion criteria"),
    repo_root: repoRoot,
    task_type: taskType.default("coding"),
    model: z
      .string()
      .min(1)
      .optional()
      .describe("Optional model in provider/model form; must be in the configured allowlist"),
    read_only: z.boolean().default(false).describe("When true, the task must not modify files"),
    timeout_seconds: z
      .number()
      .int()
      .min(1)
      .max(7200)
      .optional()
      .describe("Task timeout; the bridge's configured maximum still applies"),
    idempotency_key: z
      .string()
      .min(1)
      .max(200)
      .optional()
      .describe("Optional key that makes retries of the same spawn return the same task"),
  })
  .strict();

export const AgentStatusInput = z.object({ task_id: taskId }).strict();

export const AgentHistoryInput = z
  .object({
    task_id: taskId,
    limit: z.number().int().min(1).max(500).optional().describe("Number of recent events to return"),
    cursor: z
      .string()
      .regex(/^\d+$/)
      .optional()
      .describe("Opaque cursor for loading older events"),
    after: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe("Only return events after this sequence (forward follow)"),
    event_types: z
      .array(z.string().min(1))
      .max(50)
      .optional()
      .describe("Only return these event types"),
  })
  .strict();

export const AgentAbortInput = z.object({ task_id: taskId }).strict();

export const AgentCleanupInput = z
  .object({
    task_ids: z.array(z.string().min(1)).max(100).optional(),
    dry_run: z.boolean().default(true).describe("Plan only by default; false removes safe resources and creates approvals"),
    include_worktrees: z.boolean().default(true),
    include_logs: z.boolean().default(true),
  })
  .strict();

export const AgentMessageInput = z
  .object({
    task_id: taskId,
    message: z
      .string()
      .min(1)
      .max(100_000)
      .describe("Follow-up instruction for the same OpenCode session and workspace"),
  })
  .strict();

export const AgentDiffInput = z
  .object({
    task_id: taskId,
    file: z.string().min(1).optional().describe("Only return the diff for this repository-relative file"),
    max_chars: z
      .number()
      .int()
      .min(1000)
      .max(200000)
      .optional()
      .describe("Maximum patch characters to return (default 40000)"),
  })
  .strict();

export const AgentListInput = z
  .object({
    status: z.enum(TASK_STATUSES).optional(),
    repo_root: z.string().min(1).optional(),
    model: z.string().min(1).optional(),
    limit: z.number().int().min(1).max(100).default(20),
  })
  .strict();
