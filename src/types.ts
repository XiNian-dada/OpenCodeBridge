import type { BridgeConfig } from "./config.js";

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
  /** Read-only tasks can run against a minimal copied context workspace. */
  context_files?: string[];
  /** Optional repository-relative files/directories the worker may read. */
  read_paths?: string[];
  /** Optional repository-relative files/directories the worker may edit. */
  write_paths?: string[];
  /** Read-only task: reuse a managed worktree/context workspace owned by this task. */
  workspace_from_task_id?: string;
}

export interface ContextFile {
  path: string;
  sha256: string;
  bytes: number;
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
  context_path: string | null;
  workspace_path: string | null;
  context_files: string[];
  read_paths: string[];
  write_paths: string[];
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
  context_path: string | null;
  workspace_path: string | null;
  read_paths: string[];
  write_paths: string[];
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
  viewer_url?: string;
}

export interface TaskViewerInfo {
  url: string | null;
  auto_open: boolean;
}

export interface WaitTasksInput {
  task_ids: string[];
  timeout_seconds: number;
}

export interface WaitTasksResult {
  tasks: TaskView[];
  ready_task_ids: string[];
  timed_out: boolean;
  waited_ms: number;
}

export interface WaitEventsInput {
  task_id: string;
  after: number;
  timeout_seconds: number;
  limit: number;
}

export interface WaitEventsResult {
  events: BridgeEvent[];
  next_after: number;
  timed_out: boolean;
  task_terminal: boolean;
  waited_ms: number;
}

export interface BridgeCapabilities {
  adapter: string;
  simulated: boolean;
  build: {
    version: string;
    git_sha: string | null;
    dirty: boolean | null;
    built_at: string | null;
    config_path: string | null;
    config_revision: string | null;
  };
  models: {
    default: string | null;
    allowed: Array<{ model: string; permitted: boolean; error_code: string | null }>;
    availability: "validated_at_task_start";
    automatic_fallback: false;
  };
  scheduler: BridgeConfig["scheduler"];
  budgets: { max_tokens: number | null; max_cost_usd: number | null; enforcement: "soft" };
  provider_paused: {
    code: string;
    message: string;
    at: string;
  } | null;
  execution: {
    mcp_read_only_default: true;
    writable_supported: boolean;
    isolated_worktree_required: boolean;
    shell_allowed: false;
    read_isolation: "macos_seatbelt" | "opencode_permissions_only" | "simulated";
    write_isolation: "macos_seatbelt" | "unavailable" | "simulated";
    network: "gateway_only" | "provider_required" | "none" | "simulated";
    credential_isolation: "gateway" | "gateway_configured" | "partial" | "simulated";
    model_gateway: "auto" | "require" | "off";
  };
  limitations: string[];
}

export interface PreflightInput {
  repo_root: string;
  model?: string;
  read_only: boolean;
  context_files?: string[];
  read_paths?: string[];
  write_paths?: string[];
  workspace_from_task_id?: string;
}

export interface PreflightResult {
  adapter: string;
  simulated: boolean;
  requested: {
    repo_root: string;
    model: string | null;
    read_only: boolean;
  };
  workspace: {
    kind: "repo_root" | "isolated_worktree" | "context_snapshot" | "managed_workspace";
    repo_root: string;
    git_top_level: string | null;
    base_commit: string | null;
    path: string | null;
    planned_worktree_root: string | null;
    planned_context_root: string | null;
    worktree_required: boolean;
    worktree_ready: boolean;
    main_worktree_dirty: boolean | null;
    main_worktree_changes: string[];
  };
  model: {
    model: string;
    provider_id: string;
    model_id: string;
    variant: string | null;
    permitted: true;
    expensive: boolean;
    availability: "unverified_until_start";
  };
  permissions: {
    read: boolean;
    glob: boolean;
    grep: boolean;
    edit: boolean;
    write: boolean;
    patch: boolean;
    shell: false;
    external_directories: false;
    web: false;
    subagent: false;
    question: false;
  };
  path_policy: {
    per_file_scope: boolean;
    read_paths: string[];
    write_paths: string[];
    enforced_by: "opencode_permissions_and_diff_check" | "whole_worktree";
    protected_paths: string[];
  };
  isolation: BridgeCapabilities["execution"];
  budgets: {
    max_tokens: number | null;
    max_cost_usd: number | null;
    enforcement: "soft";
    hard_limits: string[];
    soft_limits: string[];
  };
  timeout_seconds: {
    default: number;
    max: number;
    automatic_timeout: boolean;
    zero_means: "no_automatic_timeout";
  };
  context: {
    enabled: boolean;
    planned_root: string | null;
    files: ContextFile[];
    total_bytes: number;
    note: string;
  };
  unverified: string[];
  warnings: string[];
}

export interface DeliveryOptions {
  task_id: string;
  max_chars?: number;
  include_patch?: boolean;
}

export interface DeliveryCommand {
  command: string | null;
  exit_code: number | null;
  source: "shell" | "tool" | "simulated";
  observed_at: string;
  verified_by_bridge: false;
  note?: string;
}

export interface ReviewFinding {
  location: string;
  trigger: string;
  evidence: string;
  confidence: "reproduced" | "static-inference" | "needs-confirmation";
}

export interface DeliveryFindings {
  verified: boolean;
  items: ReviewFinding[];
  note: string;
}

export interface DeliveryPackage {
  task_id: string;
  status: TaskStatus;
  generated_at: string;
  task: {
    task_type: TaskType;
    repo_root: string;
    read_only: boolean;
    root_task_id: string;
    turn: number;
    session_id: string | null;
  };
  context: {
    path: string | null;
    manifest_path: string | null;
    files: ContextFile[];
    total_bytes: number;
    verified: boolean;
  };
  model: {
    requested: string;
    actual: string | null;
    provider_id: string;
    model_id: string;
    variant: string | null;
    verified: boolean;
    simulated: boolean;
    gateway: boolean;
  };
  git: {
    available: boolean;
    reason?: "no_worktree" | "workspace_removed";
    source: "snapshot" | "live" | "unavailable";
    captured_at: string | null;
    base_commit: string | null;
    worktree_path: string | null;
    status: string;
    files: Array<{
      path: string;
      status: string;
      additions: number;
      deletions: number;
      untracked: boolean;
    }>;
    added: string[];
    modified: string[];
    deleted: string[];
    untracked: string[];
    additions: number;
    deletions: number;
    patch: string;
    patch_included: boolean;
    patch_truncated: boolean;
    patch_sha256: string | null;
    patch_bytes: number;
    display_patch_sha256: string | null;
    complete_file_count: number;
    returned_file_count: number;
    omitted_files: string[];
    truncation_reason: "max_chars" | "untracked_limit" | "both" | null;
  };
  commands: DeliveryCommand[];
  verification: {
    status: "simulated" | "unverified" | "failed";
    bridge_ran_commands: false;
    tests_run_by_bridge: false;
    notes: string[];
  };
  findings: DeliveryFindings;
  policy_snapshot: Record<string, unknown> | null;
  runtime: {
    bridge_version: string;
    bridge_git_sha: string | null;
    opencode_version: string | null;
    config_revision: string | null;
  };
  path_policy: {
    per_file_scope: boolean;
    read_paths: string[];
    write_paths: string[];
    scope_violations: string[];
  };
  budget: {
    scope: "turn";
    enforcement: "soft";
    max_tokens: number | null;
    max_cost_usd: number | null;
    exceeded: boolean;
  };
  artifacts: {
    execution_completed: boolean;
    artifact_available: boolean;
    worktree_available: boolean;
    session_usage_recorded: boolean;
  };
  usage: TaskUsage;
  session_usage: TaskUsage | null;
  usage_scope: "turn";
  session_usage_scope: "session";
  cost: { usd: number | null; known: boolean };
  unverified: string[];
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
