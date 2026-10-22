import { createHash, randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import type { BridgeConfig } from "../config.js";
import type { DiffManager, DiffResult } from "../git/diff-manager.js";
import type { WorktreeManager } from "../git/worktree-manager.js";
import { BridgeError, isBridgeError, toErrorPayload } from "../errors.js";
import type { Logger } from "../logging.js";
import type { ModelPolicy } from "../policy/model-policy.js";
import type { PathPolicy } from "../policy/path-policy.js";
import type {
  AbortTaskResult,
  BridgeEvent,
  HistoryPage,
  HistoryQuery,
  SpawnResult,
  SpawnTaskInput,
  TaskHistorySummary,
  TaskListFilter,
  TaskRecord,
  TaskSource,
  TaskStatus,
  TaskUsage,
  TaskView,
} from "../types.js";
import { emptyUsage } from "../types.js";
import type {
  AbortResult,
  AdapterEventInput,
  AdapterRunResult,
  AdapterSession,
  AgentAdapter,
} from "../adapters/adapter.js";
import { EventStore } from "./event-store.js";
import { assertTransition, isTerminal } from "./task-state.js";
import { TaskQueue } from "./task-queue.js";

interface RunHandle {
  controller: AbortController;
  session: AdapterSession | null;
  stopReason: "abort" | "timeout" | null;
  abortConfirmed: boolean | null;
}

export interface TaskManagerOptions {
  config: BridgeConfig;
  adapter: AgentAdapter;
  modelPolicy: ModelPolicy;
  pathPolicy: PathPolicy;
  eventStore: EventStore;
  logger: Logger;
  worktrees?: WorktreeManager;
  diffs?: DiffManager;
  now?: () => Date;
  idFactory?: () => string;
}

export interface TaskHistoryResult extends HistoryPage {
  task: TaskHistorySummary;
}

export interface TaskDiffResult extends DiffResult {
  task_id: string;
  reason?: "no_worktree";
}

export class TaskManager {
  private readonly tasks = new Map<string, TaskRecord>();
  private readonly idempotency = new Map<string, string>();
  private readonly queue: TaskQueue;
  private readonly running = new Map<string, RunHandle>();
  private readonly now: () => Date;
  private readonly idFactory: () => string;
  private shuttingDown = false;

  constructor(private readonly options: TaskManagerOptions) {
    this.queue = new TaskQueue(options.config.scheduler.max_queue);
    this.now = options.now ?? (() => new Date());
    this.idFactory = options.idFactory ?? (() => `task_${randomUUID()}`);
  }

  async spawn(input: SpawnTaskInput): Promise<SpawnResult> {
    const taskText = input.task.trim();
    if (taskText.length === 0) {
      throw new BridgeError("INVALID_ARGUMENT", "task must not be empty");
    }
    if (taskText.length > 100_000) {
      throw new BridgeError("INVALID_ARGUMENT", "task is too large (max 100000 characters)");
    }

    const timeoutSeconds = input.timeout_seconds;
    if (
      !Number.isInteger(timeoutSeconds) ||
      timeoutSeconds < 1 ||
      timeoutSeconds > this.options.config.scheduler.max_timeout_seconds
    ) {
      throw new BridgeError(
        "INVALID_ARGUMENT",
        `timeout_seconds must be between 1 and ${this.options.config.scheduler.max_timeout_seconds}`,
        { details: { timeout_seconds: timeoutSeconds } },
      );
    }

    const idempotencyKey = input.idempotency_key?.trim() || null;
    const fingerprint = this.fingerprint({ ...input, task: taskText });
    if (idempotencyKey !== null) {
      const existingId = this.idempotency.get(idempotencyKey);
      if (existingId !== undefined) {
        const existing = this.requireTask(existingId);
        if (existing.idempotency_fingerprint !== fingerprint) {
          throw new BridgeError(
            "IDEMPOTENCY_CONFLICT",
            `idempotency_key ${idempotencyKey} was already used with different task parameters`,
            { details: { task_id: existingId } },
          );
        }
        return { task: this.toView(existing), deduplicated: true };
      }
    }

    const resolvedModel = this.options.modelPolicy.resolve(input.model);
    if (!input.read_only && !this.options.adapter.supportsWrites) {
      throw new BridgeError(
        "SANDBOX_UNAVAILABLE",
        "This adapter does not support writable tasks yet; use read_only=true or the mock adapter",
        { details: { adapter: this.options.adapter.name } },
      );
    }
    const repo = await this.options.pathPolicy.resolveRepoRoot(input.repo_root, input.read_only);

    if (this.queue.size >= this.options.config.scheduler.max_queue) {
      throw new BridgeError("QUEUE_FULL", "The task queue is full", {
        details: { max_queue: this.options.config.scheduler.max_queue },
      });
    }

    const createdAt = this.now().toISOString();
    const taskId = this.idFactory();
    const task: TaskRecord = {
      id: taskId,
      parent_task_id: null,
      root_task_id: taskId,
      turn: 1,
      opencode_task_id: taskId,
      idempotency_key: idempotencyKey,
      idempotency_fingerprint: idempotencyKey === null ? null : fingerprint,
      task: taskText,
      repo_root: repo.repo_root,
      task_type: input.task_type,
      model: resolvedModel.model,
      provider_id: resolvedModel.provider_id,
      model_id: resolvedModel.model_id,
      model_variant: resolvedModel.variant,
      read_only: input.read_only,
      timeout_seconds: timeoutSeconds,
      status: "queued",
      stage: "queued",
      session_id: null,
      worktree_path: null,
      worktree_git_dir: null,
      base_commit: repo.base_commit,
      created_at: createdAt,
      started_at: null,
      ended_at: null,
      error_code: null,
      error_message: null,
      result_summary: null,
      usage: emptyUsage(),
      last_event_sequence: 0,
      stop_reason: null,
      cancel_requested_at: null,
    };

    this.tasks.set(task.id, task);
    if (idempotencyKey !== null) this.idempotency.set(idempotencyKey, task.id);

    this.append(
      task,
      "codex",
      "task.created",
      {
        task: taskText,
        repo_root: repo.repo_root,
        task_type: task.task_type,
        model: task.model,
        provider_id: task.provider_id,
        read_only: task.read_only,
        timeout_seconds: task.timeout_seconds,
        idempotency_key: idempotencyKey,
      },
      { maxPayloadChars: this.options.config.history.max_delegation_chars },
    );

    const queued = this.queue.enqueue(task.id);
    if (!queued.ok) {
      this.tasks.delete(task.id);
      if (idempotencyKey !== null) this.idempotency.delete(idempotencyKey);
      throw new BridgeError("QUEUE_FULL", "The task queue is full", {
        details: { max_queue: this.options.config.scheduler.max_queue },
      });
    }

    this.append(task, "bridge", "task.queued", {
      queue_position: this.queue.position(task.id),
      max_concurrent: this.options.config.scheduler.max_concurrent,
    });

    this.options.logger.info(
      { task_id: task.id, repo_root: task.repo_root, model: task.model },
      "task queued",
    );
    this.pump();
    return { task: this.toView(task), deduplicated: false };
  }

  async message(taskId: string, message: string): Promise<SpawnResult> {
    const text = message.trim();
    if (text.length === 0) {
      throw new BridgeError("INVALID_ARGUMENT", "message must not be empty");
    }
    if (text.length > 100_000) {
      throw new BridgeError("INVALID_ARGUMENT", "message is too large (max 100000 characters)");
    }

    const parent = this.requireTask(taskId);
    if (!isTerminal(parent.status)) {
      throw new BridgeError("TASK_BUSY", "Task is still running; wait or abort it before sending a message", {
        details: { task_id: parent.id, status: parent.status },
      });
    }
    if (parent.session_id === null) {
      throw new BridgeError("SESSION_LOST", "Task has no OpenCode session to continue", {
        details: { task_id: parent.id, status: parent.status },
      });
    }
    if (this.hasActiveLineage(parent.root_task_id)) {
      throw new BridgeError("TASK_BUSY", "Another turn in this task lineage is still active", {
        details: { root_task_id: parent.root_task_id },
      });
    }
    if (this.queue.size >= this.options.config.scheduler.max_queue) {
      throw new BridgeError("QUEUE_FULL", "The task queue is full", {
        details: { max_queue: this.options.config.scheduler.max_queue },
      });
    }

    const resolvedModel = this.options.modelPolicy.resolve(parent.model);
    const repo = await this.options.pathPolicy.resolveRepoRoot(parent.repo_root, parent.read_only);
    const createdAt = this.now().toISOString();
    const childId = this.idFactory();
    const child: TaskRecord = {
      id: childId,
      parent_task_id: parent.id,
      root_task_id: parent.root_task_id,
      turn: parent.turn + 1,
      opencode_task_id: parent.opencode_task_id,
      idempotency_key: null,
      idempotency_fingerprint: null,
      task: text,
      repo_root: repo.repo_root,
      task_type: parent.task_type,
      model: resolvedModel.model,
      provider_id: resolvedModel.provider_id,
      model_id: resolvedModel.model_id,
      model_variant: resolvedModel.variant,
      read_only: parent.read_only,
      timeout_seconds: parent.timeout_seconds,
      status: "queued",
      stage: "queued",
      session_id: parent.session_id,
      worktree_path: parent.worktree_path,
      worktree_git_dir: parent.worktree_git_dir,
      base_commit: parent.base_commit,
      created_at: createdAt,
      started_at: null,
      ended_at: null,
      error_code: null,
      error_message: null,
      result_summary: null,
      usage: emptyUsage(),
      last_event_sequence: 0,
      stop_reason: null,
      cancel_requested_at: null,
    };

    this.tasks.set(child.id, child);
    this.append(
      child,
      "codex",
      "task.resumed",
      {
        parent_task_id: parent.id,
        root_task_id: parent.root_task_id,
        turn: child.turn,
        session_id: parent.session_id,
        message: text,
      },
      { maxPayloadChars: this.options.config.history.max_delegation_chars },
    );
    const queued = this.queue.enqueue(child.id);
    if (!queued.ok) {
      this.tasks.delete(child.id);
      throw new BridgeError("QUEUE_FULL", "The task queue is full", {
        details: { max_queue: this.options.config.scheduler.max_queue },
      });
    }
    this.append(child, "bridge", "task.queued", {
      queue_position: this.queue.position(child.id),
      max_concurrent: this.options.config.scheduler.max_concurrent,
    });
    this.options.logger.info(
      { task_id: child.id, parent_task_id: parent.id, session_id: parent.session_id },
      "task resumed",
    );
    this.pump();
    return { task: this.toView(child), deduplicated: false };
  }

  status(taskId: string): TaskView {
    return this.toView(this.requireTask(taskId));
  }

  history(taskId: string, query: HistoryQuery): TaskHistoryResult {
    const task = this.requireTask(taskId);
    const page = this.options.eventStore.list(taskId, query);
    return { task: this.toHistorySummary(task), ...page };
  }

  list(filter: TaskListFilter): TaskView[] {
    const values = [...this.tasks.values()]
      .filter((task) => filter.status === undefined || task.status === filter.status)
      .filter(
        (task) =>
          filter.repo_root === undefined ||
          task.repo_root === filter.repo_root ||
          task.repo_root.toLowerCase() === filter.repo_root.toLowerCase(),
      )
      .filter((task) => filter.model === undefined || task.model === filter.model)
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
    return values.slice(0, filter.limit).map((task) => this.toView(task));
  }

  async diff(
    taskId: string,
    options: { file?: string; maxChars?: number } = {},
  ): Promise<TaskDiffResult> {
    const task = this.requireTask(taskId);
    if (task.worktree_path === null || task.base_commit === null) {
      return {
        task_id: task.id,
        reason: "no_worktree",
        available: false,
        worktree_path: task.worktree_path,
        base_commit: task.base_commit,
        git_status: "",
        files: [],
        added: [],
        modified: [],
        deleted: [],
        untracked: [],
        additions: 0,
        deletions: 0,
        patch: "",
        patch_truncated: false,
      };
    }
    if (this.options.diffs === undefined) {
      throw new BridgeError("WORKTREE_CREATE_FAILED", "Diff manager is not configured");
    }
    const result = await this.options.diffs.getDiff({
      worktreePath: task.worktree_path,
      baseCommit: task.base_commit,
      ...(options.file === undefined ? {} : { file: options.file }),
      ...(options.maxChars === undefined ? {} : { maxChars: options.maxChars }),
    });
    return { task_id: task.id, ...result };
  }

  async abort(taskId: string): Promise<AbortTaskResult> {
    const task = this.requireTask(taskId);
    if (isTerminal(task.status)) {
      return { task: this.toView(task), stopped: true, already_terminal: true };
    }

    if (task.status === "queued") {
      this.queue.remove(task.id);
      this.setStatus(task, "cancelled", "cancelled");
      task.ended_at = this.now().toISOString();
      task.result_summary = "Cancelled before execution";
      this.append(task, "bridge", "task.cancelled", {
        reason: "abort_before_start",
      });
      this.options.logger.info({ task_id: task.id }, "queued task cancelled");
      return { task: this.toView(task), stopped: true, already_terminal: false };
    }

    const handle = this.running.get(task.id);
    if (handle === undefined) {
      throw new BridgeError("TASK_ABORT_FAILED", "Task has no managed run handle", {
        details: { task_id: task.id, status: task.status },
      });
    }

    const stopped = await this.requestStop(task, handle, "abort");
    const terminal = await this.waitForTerminal(task.id, 5000);
    if (terminal === null) {
      throw new BridgeError("TASK_ABORT_FAILED", "Task did not reach a terminal state after abort", {
        details: { task_id: task.id, status: this.requireTask(task.id).status },
      });
    }
    if (!stopped) {
      throw new BridgeError("TASK_ABORT_FAILED", "OpenCode adapter did not confirm task stop", {
        details: { task_id: task.id, status: terminal.status },
      });
    }
    return { task: terminal, stopped: true, already_terminal: false };
  }

  async waitForTerminal(taskId: string, timeoutMs: number): Promise<TaskView | null> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const task = this.tasks.get(taskId);
      if (task === undefined || isTerminal(task.status)) {
        return task === undefined ? null : this.toView(task);
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const task = this.tasks.get(taskId);
    return task !== undefined && isTerminal(task.status) ? this.toView(task) : null;
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    const active = [...this.tasks.values()].filter((task) => !isTerminal(task.status));
    await Promise.allSettled(
      active.map(async (task) => {
        if (task.status === "queued") {
          this.queue.remove(task.id);
          this.setStatus(task, "cancelled", "cancelled");
          task.ended_at = this.now().toISOString();
          task.result_summary = "Cancelled during bridge shutdown";
          this.append(task, "system", "task.cancelled", { reason: "bridge_shutdown" });
          return;
        }
        const handle = this.running.get(task.id);
        if (handle !== undefined) {
          await this.requestStop(task, handle, "abort");
          await this.waitForTerminal(task.id, 2000);
        }
      }),
    );
    await this.options.adapter.shutdown?.();
  }

  private pump(): void {
    while (!this.shuttingDown && this.running.size < this.options.config.scheduler.max_concurrent) {
      const taskId = this.queue.dequeue();
      if (taskId === undefined) return;
      const task = this.tasks.get(taskId);
      if (task === undefined || task.status !== "queued") continue;
      void this.runTask(task).catch((error: unknown) => {
        this.options.logger.error(
          { task_id: task.id, error: toErrorPayload(error) },
          "unhandled task runner failure",
        );
      });
    }
  }

  private async runTask(task: TaskRecord): Promise<void> {
    const handle: RunHandle = {
      controller: new AbortController(),
      session: null,
      stopReason: null,
      abortConfirmed: null,
    };
    this.running.set(task.id, handle);
    task.started_at = this.now().toISOString();

    this.setStatus(task, "preparing", "preparing");
    this.append(task, "bridge", "task.started", {
      started_at: task.started_at,
      timeout_seconds: task.timeout_seconds,
    });

    const timer = setTimeout(() => {
      void this.requestStop(task, handle, "timeout").catch((error: unknown) => {
        this.options.logger.error(
          { task_id: task.id, error: toErrorPayload(error) },
          "timeout stop request failed",
        );
      });
    }, task.timeout_seconds * 1000);

    const context = {
      signal: handle.controller.signal,
      onSession: (session: AdapterSession) => {
        handle.session = session;
        task.session_id = session.id;
        task.worktree_path = session.worktree_path;
        if (task.status === "preparing") {
          this.setStatus(task, "running", "running");
        }
        this.append(task, "bridge", "session.created", {
          session_id: session.id,
          model: session.model,
          provider_id: session.provider_id,
          worktree_path: session.worktree_path,
        });
        this.options.logger.info({ task_id: task.id, session_id: session.id }, "session created");
      },
      emit: (event: AdapterEventInput) => this.handleAdapterEvent(task, event),
    };

    try {
      await this.prepareWorkspace(task);
      const prompt = this.options.adapter.buildPrompt(task);
      this.append(
        task,
        "bridge",
        "prompt.sent",
        { prompt, model: task.model, provider_id: task.provider_id },
        { maxPayloadChars: this.options.config.history.max_delegation_chars },
      );
      const result = await this.options.adapter.start(task, prompt, context);
      this.finishRun(task, handle, result);
    } catch (error) {
      this.finishRunWithError(task, handle, error);
    } finally {
      clearTimeout(timer);
      if (this.running.get(task.id) === handle) this.running.delete(task.id);
      this.pump();
    }
  }

  private async prepareWorkspace(task: TaskRecord): Promise<void> {
    if (task.read_only || !this.options.adapter.requiresIsolatedWorktree) return;
    if (task.worktree_path !== null) {
      try {
        await stat(task.worktree_path);
      } catch (error) {
        throw new BridgeError("WORKTREE_CREATE_FAILED", "Task worktree no longer exists", {
          cause: error,
          details: { task_id: task.id, worktree_path: task.worktree_path },
        });
      }
      return;
    }
    if (this.options.worktrees === undefined) {
      throw new BridgeError("WORKTREE_CREATE_FAILED", "Worktree manager is not configured");
    }

    task.stage = "preparing_workspace";
    this.append(task, "bridge", "worktree.creating", {
      repo_root: task.repo_root,
      base_commit: task.base_commit,
    });

    const result = await this.options.worktrees.create(task);
    task.worktree_path = result.path;
    task.worktree_git_dir = result.git_dir;
    task.base_commit = result.base_commit;

    this.append(task, "bridge", "worktree.created", {
      worktree_path: result.path,
      base_commit: result.base_commit,
      main_worktree_dirty: result.main_worktree_dirty,
      main_worktree_changes: result.main_worktree_changes,
    });
    if (result.main_worktree_dirty) {
      this.append(task, "system", "repo.main_worktree_dirty", {
        repo_root: task.repo_root,
        files: result.main_worktree_changes,
      });
    }
  }

  private finishRun(task: TaskRecord, handle: RunHandle, result: AdapterRunResult): void {
    const usage = result.usage ?? task.usage;

    if (handle.stopReason === "timeout") {
      this.finalize(task, "timed_out", {
        summary: result.summary,
        usage,
        error: { code: "TASK_TIMEOUT", message: `Task exceeded ${task.timeout_seconds}s timeout` },
      });
      return;
    }

    if (handle.stopReason === "abort") {
      if (handle.abortConfirmed === false) {
        this.finalize(task, "interrupted", {
          summary: result.summary,
          usage,
          error: { code: "TASK_ABORT_FAILED", message: "Adapter did not confirm task stop" },
        });
        return;
      }
      this.finalize(task, "cancelled", {
        summary: result.summary,
        usage,
        error: { code: "TASK_ABORTED", message: "Task was cancelled" },
      });
      return;
    }

    if (result.stopped === true) {
      this.finalize(task, "interrupted", {
        summary: result.summary,
        usage,
        error: { code: "SESSION_LOST", message: "Adapter stopped without a cancel or timeout request" },
      });
      return;
    }

    this.finalize(task, "completed", {
      summary: result.summary,
      usage,
      error: null,
    });
  }

  private finishRunWithError(task: TaskRecord, handle: RunHandle, error: unknown): void {
    const payload = toErrorPayload(error);

    if (handle.stopReason === "timeout") {
      this.finalize(task, "timed_out", {
        summary: null,
        usage: task.usage,
        error: { code: "TASK_TIMEOUT", message: `Task exceeded ${task.timeout_seconds}s timeout` },
      });
      return;
    }

    if (handle.stopReason === "abort") {
      this.finalize(
        task,
        handle.abortConfirmed === false ? "interrupted" : "cancelled",
        {
          summary: null,
          usage: task.usage,
          error:
            handle.abortConfirmed === false
              ? { code: "TASK_ABORT_FAILED", message: "Adapter did not confirm task stop" }
              : { code: "TASK_ABORTED", message: "Task was cancelled" },
        },
      );
      return;
    }

    if (isBridgeError(error) && error.code === "TASK_ABORTED") {
      this.finalize(task, "interrupted", {
        summary: null,
        usage: task.usage,
        error: { code: "SESSION_LOST", message: "Adapter aborted without a bridge request" },
      });
      return;
    }

    this.finalize(task, "failed", {
      summary: null,
      usage: task.usage,
      error: { code: payload.code, message: payload.message },
    });
  }

  private finalize(
    task: TaskRecord,
    status: TaskStatus,
    options: {
      summary: string | null;
      usage: TaskUsage;
      error: { code: string; message: string } | null;
    },
  ): void {
    if (isTerminal(task.status)) return;

    this.setStatus(task, status, status);
    task.ended_at = this.now().toISOString();
    task.result_summary = options.summary;
    task.usage = options.usage;
    task.error_code = options.error?.code ?? null;
    task.error_message = options.error?.message ?? null;
    task.stop_reason = null;

    const eventType =
      status === "completed"
        ? "task.completed"
        : status === "cancelled"
          ? "task.cancelled"
          : status === "timed_out"
            ? "task.timed_out"
            : status === "interrupted"
              ? "task.interrupted"
              : "task.failed";

    this.append(task, status === "completed" || status === "cancelled" ? "bridge" : "system", eventType, {
      status,
      summary: options.summary,
      error: options.error,
      usage: options.usage,
      duration_ms: this.durationMs(task),
    });

    this.options.logger.info(
      { task_id: task.id, status, error: options.error },
      "task finished",
    );
  }

  private async requestStop(
    task: TaskRecord,
    handle: RunHandle,
    reason: "abort" | "timeout",
  ): Promise<boolean> {
    if (handle.stopReason === null) handle.stopReason = reason;
    if (task.stop_reason === null) task.stop_reason = reason;

    if (reason === "abort" && !isTerminal(task.status) && task.status !== "cancelling") {
      const previousStatus = task.status;
      this.setStatus(task, "cancelling", "cancelling");
      task.cancel_requested_at = this.now().toISOString();
      this.append(task, "bridge", "task.cancelling", {
        reason: "user_abort",
        previous_status: previousStatus,
      });
    }

    if (reason === "timeout") {
      this.append(task, "bridge", "task.timeout_requested", {
        timeout_seconds: task.timeout_seconds,
      });
    }

    let stopped = true;
    if (handle.session !== null) {
      try {
        const result: AbortResult = await this.options.adapter.abort(handle.session);
        stopped = result.stopped;
      } catch (error) {
        stopped = false;
        this.options.logger.warn(
          { task_id: task.id, error: toErrorPayload(error) },
          "adapter abort failed",
        );
      }
    }
    handle.abortConfirmed = stopped;

    if (!handle.controller.signal.aborted) {
      handle.controller.abort(
        new BridgeError(
          reason === "timeout" ? "TASK_TIMEOUT" : "TASK_ABORTED",
          reason === "timeout" ? "Task timed out" : "Task aborted",
        ),
      );
    }

    return stopped;
  }

  private handleAdapterEvent(task: TaskRecord, event: AdapterEventInput): void {
    this.append(task, event.source, event.event_type, event.payload);

    if (event.event_type === "usage.updated") {
      const usage = parseUsage(event.payload.usage);
      if (usage !== null) task.usage = usage;
    }

    if (event.event_type === "permission.requested" && task.status === "running") {
      this.setStatus(task, "waiting_permission", "waiting_permission");
    } else if (event.event_type === "permission.replied" && task.status === "waiting_permission") {
      this.setStatus(task, "running", "running");
    } else if (event.event_type === "session.idle" && task.status === "running") {
      task.stage = "idle";
    }
  }

  private append(
    task: TaskRecord,
    source: TaskSource,
    eventType: string,
    payload: Record<string, unknown>,
    options?: { maxPayloadChars?: number },
  ): BridgeEvent {
    const event = this.options.eventStore.append(
      task.id,
      task.session_id,
      source,
      eventType,
      payload,
      options,
    );
    task.last_event_sequence = event.sequence;
    return event;
  }

  private setStatus(task: TaskRecord, status: TaskStatus, stage: string): void {
    if (task.status === status) {
      task.stage = stage;
      return;
    }
    assertTransition(task.status, status);
    task.status = status;
    task.stage = stage;
  }

  private requireTask(taskId: string): TaskRecord {
    const task = this.tasks.get(taskId);
    if (task === undefined) {
      throw new BridgeError("TASK_NOT_FOUND", `Task not found: ${taskId}`, {
        details: { task_id: taskId },
      });
    }
    return task;
  }

  private durationMs(task: TaskRecord): number {
    if (task.started_at === null) return 0;
    const end = task.ended_at === null ? this.now().getTime() : Date.parse(task.ended_at);
    return Math.max(0, end - Date.parse(task.started_at));
  }

  private toView(task: TaskRecord): TaskView {
    const last = this.options.eventStore.last(task.id);
    return {
      task_id: task.id,
      parent_task_id: task.parent_task_id,
      root_task_id: task.root_task_id,
      turn: task.turn,
      status: task.status,
      stage: task.stage,
      model: task.model,
      provider_id: task.provider_id,
      repo_root: task.repo_root,
      task_type: task.task_type,
      read_only: task.read_only,
      timeout_seconds: task.timeout_seconds,
      session_id: task.session_id,
      worktree_path: task.worktree_path,
      created_at: task.created_at,
      started_at: task.started_at,
      ended_at: task.ended_at,
      duration_ms: this.durationMs(task),
      usage: { ...task.usage },
      estimated_cost_usd: task.usage.cost_usd,
      cost_known: task.usage.cost_known,
      error:
        task.error_code === null
          ? null
          : { code: task.error_code, message: task.error_message ?? "" },
      result_summary: task.result_summary,
      last_event:
        last === undefined
          ? null
          : {
              sequence: last.sequence,
              source: last.source,
              event_type: last.event_type,
              timestamp: last.timestamp,
            },
      queue_position: task.status === "queued" ? this.queue.position(task.id) : null,
    };
  }

  private toHistorySummary(task: TaskRecord): TaskHistorySummary {
    return {
      task_id: task.id,
      parent_task_id: task.parent_task_id,
      root_task_id: task.root_task_id,
      turn: task.turn,
      session_id: task.session_id,
      task: task.task,
      repo_root: task.repo_root,
      task_type: task.task_type,
      model: task.model,
      read_only: task.read_only,
      timeout_seconds: task.timeout_seconds,
      status: task.status,
      created_at: task.created_at,
    };
  }

  private hasActiveLineage(rootTaskId: string): boolean {
    for (const task of this.tasks.values()) {
      if (task.root_task_id === rootTaskId && !isTerminal(task.status)) return true;
    }
    return false;
  }

  private fingerprint(input: SpawnTaskInput): string {
    return createHash("sha256")
      .update(
        JSON.stringify({
          task: input.task,
          repo_root: input.repo_root,
          task_type: input.task_type,
          model: input.model ?? this.options.config.models.default,
          read_only: input.read_only,
          timeout_seconds: input.timeout_seconds,
        }),
      )
      .digest("hex");
  }
}

function parseUsage(value: unknown): TaskUsage | null {
  if (typeof value !== "object" || value === null) return null;
  const usage = value as Partial<TaskUsage>;
  if (typeof usage.input_tokens !== "number" || typeof usage.output_tokens !== "number") return null;
  return {
    input_tokens: usage.input_tokens,
    output_tokens: usage.output_tokens,
    reasoning_tokens: usage.reasoning_tokens ?? 0,
    cache_read_tokens: usage.cache_read_tokens ?? 0,
    cache_write_tokens: usage.cache_write_tokens ?? 0,
    total_tokens: usage.total_tokens ?? usage.input_tokens + usage.output_tokens,
    model_calls: usage.model_calls ?? 1,
    cost_usd: usage.cost_usd ?? null,
    cost_known: usage.cost_known ?? usage.cost_usd !== null,
  };
}
