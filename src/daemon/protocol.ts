import * as z from "zod/v4";
import { BridgeError, type ErrorPayload } from "../errors.js";
import { TASK_STATUSES, TASK_TYPES } from "../types.js";

export const IPC_METHODS = [
  "viewer",
  "capabilities",
  "preflight",
  "wait",
  "events",
  "spawn",
  "status",
  "history",
  "message",
  "abort",
  "diff",
  "delivery",
  "list",
  "cleanup",
  "approve_cleanup",
  "resume_provider",
  "shutdown",
] as const;

export type IpcMethod = (typeof IPC_METHODS)[number];

export const IpcRequestSchema = z
  .object({
    id: z.string().min(1),
    method: z.enum(IPC_METHODS),
    params: z.unknown().optional(),
  })
  .strict();

export type IpcRequest = z.infer<typeof IpcRequestSchema>;

export interface IpcSuccess {
  id: string;
  ok: true;
  result: unknown;
}

export interface IpcFailure {
  id: string;
  ok: false;
  error: ErrorPayload;
}

export type IpcResponse = IpcSuccess | IpcFailure;

const SpawnParams = z
  .object({
    task: z.string().min(1).max(100_000),
    repo_root: z.string().min(1),
    task_type: z.enum(TASK_TYPES),
    model: z.string().min(1).optional(),
    read_only: z.boolean(),
    timeout_seconds: z.number().int().min(1).max(7200),
    idempotency_key: z.string().min(1).max(200).optional(),
    context_files: z.array(z.string().min(1)).max(100).optional(),
  })
  .strict();

const StatusParams = z.object({ task_id: z.string().min(1) }).strict();
const PreflightParams = z
  .object({
    repo_root: z.string().min(1),
    model: z.string().min(1).optional(),
    read_only: z.boolean(),
    context_files: z.array(z.string().min(1)).max(100).optional(),
  })
  .strict();
const DeliveryParams = z
  .object({
    task_id: z.string().min(1),
    max_chars: z.number().int().min(1000).max(200_000).optional(),
  })
  .strict();
const WaitParams = z.object({
  task_ids: z.array(z.string().min(1)).min(1).max(8),
  timeout_seconds: z.number().int().min(0).max(50),
}).strict();
const EventsParams = z
  .object({
    task_id: z.string().min(1),
    after: z.number().int().nonnegative(),
    timeout_seconds: z.number().int().min(0).max(50),
    limit: z.number().int().min(1).max(100),
  })
  .strict();
const MessageParams = z
  .object({
    task_id: z.string().min(1),
    message: z.string().min(1).max(100_000),
    context_files: z.array(z.string().min(1)).max(100).optional(),
  })
  .strict();
const AbortParams = z.object({ task_id: z.string().min(1) }).strict();
const HistoryParams = z
  .object({
    task_id: z.string().min(1),
    limit: z.number().int().min(1).max(500),
    cursor: z.string().regex(/^\d+$/).optional(),
    after: z.number().int().nonnegative().optional(),
    types: z.array(z.string().min(1)).max(50).optional(),
  })
  .strict();
const DiffParams = z
  .object({
    task_id: z.string().min(1),
    file: z.string().min(1).optional(),
    max_chars: z.number().int().min(1000).max(200_000).optional(),
  })
  .strict();
const ListParams = z
  .object({
    status: z.enum(TASK_STATUSES).optional(),
    repo_root: z.string().min(1).optional(),
    model: z.string().min(1).optional(),
    limit: z.number().int().min(1).max(100),
  })
  .strict();
const CleanupParams = z
  .object({
    task_ids: z.array(z.string().min(1)).max(100).optional(),
    dry_run: z.boolean(),
    include_worktrees: z.boolean(),
    include_logs: z.boolean(),
  })
  .strict();
const ApproveCleanupParams = z.object({ approval_id: z.string().min(1) }).strict();
const ResumeProviderParams = z.object({}).strict();

export function parseParams<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new BridgeError(
      "INVALID_ARGUMENT",
      `Invalid IPC parameters: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`,
    );
  }
  return parsed.data;
}

export const IpcParams = {
  viewer: z.object({}).strict(),
  capabilities: z.object({}).strict(),
  preflight: PreflightParams,
  wait: WaitParams,
  events: EventsParams,
  spawn: SpawnParams,
  status: StatusParams,
  message: MessageParams,
  abort: AbortParams,
  history: HistoryParams,
  diff: DiffParams,
  delivery: DeliveryParams,
  list: ListParams,
  cleanup: CleanupParams,
  approve_cleanup: ApproveCleanupParams,
  resume_provider: ResumeProviderParams,
} as const;
