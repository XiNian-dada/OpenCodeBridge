import * as z from "zod/v4";
import { TASK_STATUSES, TASK_TYPES } from "../types.js";

const taskId = z.string().min(1).describe("Bridge task ID (for example task_...)");

const repoRoot = z
  .string()
  .min(1)
  .describe("Absolute path to the target Git repository (or an allowed directory for read-only tasks)");

const taskType = z.enum(TASK_TYPES).describe("Task category");
const taskDetail = z.enum(["summary", "full"]).default("summary")
  .describe("Compact snapshot by default (result summary capped at 2000 characters); full returns all stored status fields and the complete result summary");

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
    read_only: z.boolean().default(true).describe("Defaults to read-only; explicitly set false only for an authorized isolated edit task"),
    timeout_seconds: z
      .number()
      .int()
      .min(0)
      .max(31_536_000)
      .optional()
      .describe("Optional hard execution deadline. Omit for the configured default; 0 disables the automatic timeout and leaves stopping to agent_abort"),
    idempotency_key: z
      .string()
      .min(1)
      .max(200)
      .optional()
      .describe("Optional key that makes retries of the same spawn return the same task"),
    context_files: z
      .array(z.string().min(1))
      .max(100)
      .optional()
      .describe("Read-only tasks only: repository-relative files to copy into a minimal context workspace; dependencies are not resolved automatically"),
    read_paths: z
      .array(z.string().min(1))
      .max(100)
      .optional()
      .describe("Optional repository-relative read paths to declare; reads outside may still be needed for dependencies"),
    write_paths: z
      .array(z.string().min(1))
      .max(100)
      .optional()
      .describe("Writable tasks only: repo-relative files or directories ending in / that the worker may edit; violations fail the task"),
    workspace_from_task_id: z
      .string()
      .min(1)
      .optional()
      .describe("Read-only only: reuse a completed task's managed worktree/context workspace for a new session"),
  })
  .strict();

export const AgentStatusInput = z.object({ task_id: taskId, detail: taskDetail }).strict();

export const AgentCapabilitiesInput = z.object({}).strict();
export const AgentViewerInput = z.object({}).strict();

export const AgentPreflightInput = z
  .object({
    repo_root: repoRoot,
    model: z
      .string()
      .min(1)
      .optional()
      .describe("Optional model in provider/model form; validated against the allowlist"),
    read_only: z
      .boolean()
      .default(true)
      .describe("Plan a read-only task (default) or an isolated writable task"),
    context_files: z
      .array(z.string().min(1))
      .max(100)
      .optional()
      .describe("Read-only tasks only: repository-relative files to hash and plan for the context workspace"),
    read_paths: z.array(z.string().min(1)).max(100).optional(),
    write_paths: z.array(z.string().min(1)).max(100).optional(),
    workspace_from_task_id: z.string().min(1).optional(),
  })
  .strict();

export const AgentDeliveryInput = z
  .object({
    task_id: taskId,
    max_chars: z
      .number()
      .int()
      .min(1000)
      .max(200000)
      .optional()
      .describe("Maximum patch characters to include (default 200000)"),
    include_patch: z
      .boolean()
      .default(true)
      .describe("Set false to return only metadata and stable hashes without patch text"),
  })
  .strict();

export const AgentResultInput = z
  .object({
    task_id: taskId,
  })
  .strict();

export const AgentWaitInput = z.object({
  task_ids: z.array(taskId).min(1).max(8).describe("Tasks to wait on; returns when any is terminal or needs permission"),
  timeout_seconds: z.number().int().min(0).max(50).default(30)
    .describe("Maximum wait, independent of task execution timeout; 0 returns immediately"),
  detail: taskDetail,
}).strict();

export const AgentEventsInput = z
  .object({
    task_id: taskId,
    after: z.number().int().nonnegative().default(0)
      .describe("Only return events with a sequence greater than this value"),
    timeout_seconds: z.number().int().min(0).max(50).default(30)
      .describe("Maximum long-poll wait; 0 returns immediately. Does not stop the task."),
    limit: z.number().int().min(1).max(100).default(100),
  })
  .strict();

export const AgentHistoryInput = z
  .object({
    task_id: taskId,
    include_task: z.boolean().default(false)
      .describe("Include the original task text in the header; omitted by default to avoid repeating it on every page"),
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
    context_files: z
      .array(z.string().min(1))
      .max(100)
      .optional()
      .describe("Read-only lineage only: additional repository-relative files to include in a new context snapshot"),
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
    detail: taskDetail,
    status: z.enum(TASK_STATUSES).optional(),
    repo_root: z.string().min(1).optional(),
    model: z.string().min(1).optional(),
    limit: z.number().int().min(1).max(100).default(20),
  })
  .strict();
