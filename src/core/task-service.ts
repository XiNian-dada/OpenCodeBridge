import type { BridgeConfig } from "../config.js";
import type { DiffResult } from "../git/diff-manager.js";
import type {
  AbortTaskResult,
  HistoryPage,
  HistoryQuery,
  SpawnResult,
  SpawnTaskInput,
  TaskHistorySummary,
  TaskListFilter,
  TaskView,
} from "../types.js";
import type { TaskManager } from "./task-manager.js";

export interface TaskHistoryResult extends HistoryPage {
  task: TaskHistorySummary;
}

export interface TaskDiffResult extends DiffResult {
  task_id: string;
  reason?: "no_worktree";
}

export interface ToolServices {
  config: BridgeConfig;
  service: TaskService;
}

export interface TaskService {
  spawn(input: SpawnTaskInput): Promise<SpawnResult>;
  status(taskId: string): Promise<TaskView>;
  history(taskId: string, query: HistoryQuery): Promise<TaskHistoryResult>;
  message(taskId: string, message: string): Promise<SpawnResult>;
  abort(taskId: string): Promise<AbortTaskResult>;
  diff(
    taskId: string,
    options?: { file?: string; maxChars?: number },
  ): Promise<TaskDiffResult>;
  list(filter: TaskListFilter): Promise<TaskView[]>;
}

export class LocalTaskService implements TaskService {
  constructor(private readonly manager: TaskManager) {}

  spawn(input: SpawnTaskInput): Promise<SpawnResult> {
    return this.manager.spawn(input);
  }

  async status(taskId: string): Promise<TaskView> {
    return this.manager.status(taskId);
  }

  async history(taskId: string, query: HistoryQuery): Promise<TaskHistoryResult> {
    return this.manager.history(taskId, query);
  }

  message(taskId: string, message: string): Promise<SpawnResult> {
    return this.manager.message(taskId, message);
  }

  abort(taskId: string): Promise<AbortTaskResult> {
    return this.manager.abort(taskId);
  }

  diff(
    taskId: string,
    options: { file?: string; maxChars?: number } = {},
  ): Promise<TaskDiffResult> {
    return this.manager.diff(taskId, options);
  }

  async list(filter: TaskListFilter): Promise<TaskView[]> {
    return this.manager.list(filter);
  }
}
