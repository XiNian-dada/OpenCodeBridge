export const TASK_STATUSES = [
  "queued",
  "preparing",
  "running",
  "waiting_permission",
  "completed",
  "failed",
  "timed_out",
  "cancelling",
  "cancelled",
  "interrupted",
  "blocked",
] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];

export const TASK_TYPES = [
  "coding",
  "testing",
  "documentation",
  "analysis",
  "review",
  "refactor",
] as const;

export type TaskType = (typeof TASK_TYPES)[number];

export const TASK_SOURCES = ["codex", "bridge", "opencode", "tool", "system"] as const;

export type TaskSource = (typeof TASK_SOURCES)[number];

export type StopReason = "abort" | "timeout" | "budget" | null;

export interface TaskUsage {
  input_tokens: number;
  output_tokens: number;
  reasoning_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  total_tokens: number;
  model_calls: number;
  cost_usd: number | null;
  cost_known: boolean;
}

export function emptyUsage(): TaskUsage {
  return {
    input_tokens: 0,
    output_tokens: 0,
    reasoning_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    total_tokens: 0,
    model_calls: 0,
    cost_usd: null,
    cost_known: false,
  };
}

export interface SpawnTaskInput {
  task: string;
  repo_root: string;
  task_type: TaskType;
  model?: string;
  read_only: boolean;
  timeout_seconds: number;
  idempotency_key?: string;
}

export interface TaskRecord {
  id: string;
  parent_task_id: string | null;
  root_task_id: string;
  turn: number;
  opencode_task_id: string;
  idempotency_key: string | null;
  idempotency_fingerprint: string | null;
  task: string;
  repo_root: string;
  task_type: TaskType;
  model: string;
  provider_id: string;
  model_id: string;
  model_variant: string | null;
  read_only: boolean;
  timeout_seconds: number;
  status: TaskStatus;
  stage: string;
  session_id: string | null;
  server_pid: number | null;
  worktree_path: string | null;
  worktree_git_dir: string | null;
  base_commit: string | null;
  created_at: string;
  started_at: string | null;
  ended_at: string | null;
  error_code: string | null;
  error_message: string | null;
  result_summary: string | null;
  usage: TaskUsage;
  last_event_sequence: number;
  stop_reason: StopReason;
  cancel_requested_at: string | null;
}

export interface TaskLastEvent {
  sequence: number;
  source: TaskSource;
  event_type: string;
  timestamp: string;
}

export interface TaskErrorView {
  code: string;
  message: string;
}

export interface TaskView {
  task_id: string;
  parent_task_id: string | null;
  root_task_id: string;
  turn: number;
  status: TaskStatus;
  stage: string;
  model: string;
  provider_id: string;
  repo_root: string;
  task_type: TaskType;
  read_only: boolean;
  timeout_seconds: number;
  session_id: string | null;
  worktree_path: string | null;
  created_at: string;
  started_at: string | null;
  ended_at: string | null;
  duration_ms: number;
  usage: TaskUsage;
  estimated_cost_usd: number | null;
  cost_known: boolean;
  error: TaskErrorView | null;
  result_summary: string | null;
  last_event: TaskLastEvent | null;
  queue_position: number | null;
}

export interface TaskHistorySummary {
  task_id: string;
  parent_task_id: string | null;
  root_task_id: string;
  turn: number;
  session_id: string | null;
  task: string;
  repo_root: string;
  task_type: TaskType;
  model: string;
  read_only: boolean;
  timeout_seconds: number;
  status: TaskStatus;
  created_at: string;
}

export interface BridgeEvent {
  event_id: string;
  task_id: string;
  session_id: string | null;
  timestamp: string;
  sequence: number;
  source: TaskSource;
  event_type: string;
  payload: Record<string, unknown>;
}

export interface HistoryQuery {
  limit: number;
  cursor?: string;
  after?: number;
  types?: string[];
}

export interface HistoryPage {
  events: BridgeEvent[];
  next_cursor: string | null;
  has_more: boolean;
  total: number;
}

export interface TaskListFilter {
  status?: TaskStatus;
  repo_root?: string;
  model?: string;
  limit: number;
}

export interface SpawnResult {
  task: TaskView;
  deduplicated: boolean;
}

export interface AbortTaskResult {
  task: TaskView;
  stopped: boolean;
  already_terminal: boolean;
}

export interface CleanupOptions {
  task_ids?: string[];
  dry_run: boolean;
  include_worktrees: boolean;
  include_logs: boolean;
}

export type CleanupActionKind = "worktree" | "log";

export type CleanupActionStatus = "planned" | "removed" | "skipped" | "approval_required";

export interface CleanupAction {
  kind: CleanupActionKind;
  path: string;
  status: CleanupActionStatus;
  reason?: string;
  task_id?: string;
  approval_id?: string;
  bytes?: number;
}

export interface CleanupResult {
  dry_run: boolean;
  actions: CleanupAction[];
  errors: string[];
}

export interface ApprovalRecord {
  id: string;
  kind: string;
  payload: Record<string, unknown>;
  created_at: string;
  consumed_at: string | null;
}
