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
  CleanupOptions,
  CleanupResult,
  BridgeCapabilities,
  WaitTasksInput,
  WaitTasksResult,
  TaskViewerInfo,
  PreflightInput,
  PreflightResult,
  DeliveryOptions,
  DeliveryPackage,
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
  viewer(): Promise<TaskViewerInfo>;
  capabilities(): Promise<BridgeCapabilities>;
  preflight(input: PreflightInput): Promise<PreflightResult>;
  wait(input: WaitTasksInput, signal?: AbortSignal): Promise<WaitTasksResult>;
  spawn(input: SpawnTaskInput): Promise<SpawnResult>;
  status(taskId: string): Promise<TaskView>;
  history(taskId: string, query: HistoryQuery): Promise<TaskHistoryResult>;
  message(taskId: string, message: string, contextFiles?: string[]): Promise<SpawnResult>;
  abort(taskId: string): Promise<AbortTaskResult>;
  diff(
    taskId: string,
    options?: { file?: string; maxChars?: number },
  ): Promise<TaskDiffResult>;
  delivery(options: DeliveryOptions): Promise<DeliveryPackage>;
  list(filter: TaskListFilter): Promise<TaskView[]>;
  cleanup(options: CleanupOptions): Promise<CleanupResult>;
  approveCleanup(approvalId: string): Promise<CleanupResult>;
  resumeProvider(): Promise<{ resumed: boolean }>;
}

export class LocalTaskService implements TaskService {
  private taskViewer?: {
    info(): TaskViewerInfo;
    showTask(taskId: string): void;
  };

  constructor(private readonly manager: TaskManager) {}

  setViewer(viewer: NonNullable<LocalTaskService["taskViewer"]>): void {
    this.taskViewer = viewer;
  }

  async viewer(): Promise<TaskViewerInfo> {
    return this.taskViewer?.info() ?? { url: null, auto_open: false };
  }

  private show(result: SpawnResult): SpawnResult {
    this.taskViewer?.showTask(result.task.task_id);
    const url = this.taskViewer?.info().url;
    return url ? { ...result, viewer_url: url } : result;
  }

  async capabilities(): Promise<BridgeCapabilities> {
    return this.manager.capabilities();
  }

  async preflight(input: PreflightInput): Promise<PreflightResult> {
    return this.manager.preflight(input);
  }

  wait(input: WaitTasksInput, signal?: AbortSignal): Promise<WaitTasksResult> {
    return this.manager.wait(input, signal);
  }

  async spawn(input: SpawnTaskInput): Promise<SpawnResult> {
    return this.show(await this.manager.spawn(input));
  }

  async status(taskId: string): Promise<TaskView> {
    return this.manager.status(taskId);
  }

  async history(taskId: string, query: HistoryQuery): Promise<TaskHistoryResult> {
    return this.manager.history(taskId, query);
  }

  async message(taskId: string, message: string, contextFiles: string[] = []): Promise<SpawnResult> {
    return this.show(await this.manager.message(taskId, message, contextFiles));
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

  async delivery(options: DeliveryOptions): Promise<DeliveryPackage> {
    return this.manager.delivery(options);
  }

  async list(filter: TaskListFilter): Promise<TaskView[]> {
    return this.manager.list(filter);
  }

  cleanup(options: CleanupOptions): Promise<CleanupResult> {
    return this.manager.cleanup(options);
  }

  approveCleanup(approvalId: string): Promise<CleanupResult> {
    return this.manager.approveCleanup(approvalId);
  }

  async resumeProvider(): Promise<{ resumed: boolean }> {
    return this.manager.resumeProvider();
  }
}
