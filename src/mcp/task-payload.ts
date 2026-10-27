import type { TaskView } from "../types.js";

export type TaskDetail = "summary" | "full";
const MAX_SUMMARY_CHARS = 2000;

export function taskPayload(task: TaskView, detail: TaskDetail = "full"): Record<string, unknown> {
  if (detail === "full") return task as unknown as Record<string, unknown>;
  const summary = task.result_summary;
  return {
    task_id: task.task_id,
    parent_task_id: task.parent_task_id,
    root_task_id: task.root_task_id,
    turn: task.turn,
    status: task.status,
    stage: task.stage,
    model: task.model,
    repo_root: task.repo_root,
    read_only: task.read_only,
    session_id: task.session_id,
    worktree_path: task.worktree_path,
    context_path: task.context_path,
    workspace_path: task.workspace_path,
    read_paths: task.read_paths,
    write_paths: task.write_paths,
    duration_ms: task.duration_ms,
    queue_position: task.queue_position,
    total_tokens: task.usage.total_tokens,
    estimated_cost_usd: task.estimated_cost_usd,
    error: task.error,
    result_summary: summary?.slice(0, MAX_SUMMARY_CHARS) ?? null,
    ...(summary !== null && summary.length > MAX_SUMMARY_CHARS
      ? { result_summary_truncated: true, result_summary_chars: summary.length }
      : {}),
    last_event: task.last_event,
  };
}
