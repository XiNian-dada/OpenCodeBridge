import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { mkdir, readFile, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { BridgeConfig } from "../config.js";
import type { DiffManager } from "../git/diff-manager.js";
import type { TaskDiffResult, TaskHistoryResult } from "./task-service.js";
import type { SqliteStore } from "../storage/sqlite-store.js";
import { resolveDataDir } from "../paths.js";
import type { WorktreeManager } from "../git/worktree-manager.js";
import { BridgeError, isBridgeError, toErrorPayload } from "../errors.js";
import type { Logger } from "../logging.js";
import type { ModelPolicy } from "../policy/model-policy.js";
import type { PathPolicy } from "../policy/path-policy.js";
import type {
  AbortTaskResult,
  ApprovalRecord,
  BridgeEvent,
  BridgeCapabilities,
  CleanupAction,
  CleanupOptions,
  CleanupResult,
  ContextFile,
  DeliveryCommand,
  DeliveryOptions,
  DeliveryPackage,
  HistoryQuery,
  PreflightInput,
  PreflightResult,
  SpawnResult,
  SpawnTaskInput,
  TaskHistorySummary,
  TaskListFilter,
  TaskRecord,
  TaskSource,
  TaskStatus,
  TaskUsage,
  TaskView,
  WaitTasksInput,
  WaitTasksResult,
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
import {
  inspectContextFiles,
  normalizeContextPaths,
  writeContextSnapshot,
} from "./context-snapshot.js";
import { parseReviewFindings } from "./findings.js";

interface RunHandle {
  controller: AbortController;
  session: AdapterSession | null;
  stopReason: "abort" | "timeout" | "budget" | null;
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
  store?: SqliteStore;
  now?: () => Date;
  idFactory?: () => string;
}

export class TaskManager {
  private readonly tasks = new Map<string, TaskRecord>();
  private readonly idempotency = new Map<string, string>();
  private readonly queue: TaskQueue;
  private readonly running = new Map<string, RunHandle>();
  private readonly now: () => Date;
  private readonly idFactory: () => string;
  private readonly store: SqliteStore | undefined;
  private readonly approvals = new Map<string, ApprovalRecord>();
  private shuttingDown = false;
  private providerPause: { code: string; message: string; at: string } | null = null;

  constructor(private readonly options: TaskManagerOptions) {
    this.queue = new TaskQueue(options.config.scheduler.max_queue);
    this.now = options.now ?? (() => new Date());
    this.idFactory = options.idFactory ?? (() => `task_${randomUUID()}`);
    this.store = options.store;
    if (this.store !== undefined) this.recoverFromStore();
  }

  capabilities(): BridgeCapabilities {
    const { config, adapter, modelPolicy } = this.options;
    const simulated = adapter.name === "mock";
    return {
      adapter: adapter.name,
      simulated,
      models: {
        default: config.models.default,
        allowed: config.models.allow.map((model) => {
          try {
            modelPolicy.resolve(model);
            return { model, permitted: true, error_code: null };
          } catch (error) {
            return { model, permitted: false, error_code: toErrorPayload(error).code };
          }
        }),
        availability: "validated_at_task_start",
        automatic_fallback: false,
      },
      scheduler: { ...config.scheduler },
      budgets: {
        max_tokens: config.models.max_tokens,
        max_cost_usd: config.models.max_cost_usd,
        enforcement: "soft",
      },
      provider_paused: this.providerPause === null ? null : { ...this.providerPause },
      execution: {
        mcp_read_only_default: true,
        writable_supported: adapter.supportsWrites,
        isolated_worktree_required: adapter.requiresIsolatedWorktree,
        shell_allowed: false,
        read_isolation: simulated
          ? "simulated"
          : adapter.supportsReadIsolation === true
            ? "macos_seatbelt"
            : "opencode_permissions_only",
        write_isolation: simulated ? "simulated" : adapter.supportsWrites ? "macos_seatbelt" : "unavailable",
        network: simulated
          ? "simulated"
          : config.security.model_gateway === "off"
            ? "provider_required"
            : "gateway_only",
        credential_isolation: simulated
          ? "simulated"
          : config.security.model_gateway === "off"
            ? "partial"
            : config.security.model_gateway === "require"
              ? "gateway"
              : "gateway_configured",
        model_gateway: config.security.model_gateway,
      },
      limitations: simulated
        ? ["Mock results and tool events are simulated; no real model or code execution."]
        : [
            "Model IDs are configured policy entries, not a live provider availability or quota check.",
            ...(adapter.supportsReadIsolation === true
              ? [
                  "Read-only tasks use a macOS Seatbelt denylist: the user home, external mounts, and system temp are hidden, but the OpenCode process still needs its provider auth/config directories to call the model. Tool access to those directories is denied.",
                ]
              : [
                  "Read access is not confined by an OS sandbox; per-file delegation scope is not enforced.",
                ]),
            "Model calls require network access; worker web, shell, subagent, and external-directory tools are denied.",
            "Writable tasks are edit-only; Codex must run tests and review and integrate the diff.",
            "Internal OpenCode model calls are not independently verified by this capability query.",
            "Budgets are soft; unknown provider cost cannot be enforced as a hard spending cap.",
          ],
    };
  }

  async preflight(input: PreflightInput): Promise<PreflightResult> {
    this.assertProviderReady();
    const { config, adapter, modelPolicy, pathPolicy } = this.options;
    const simulated = adapter.name === "mock";
    const model = modelPolicy.resolve(input.model);
    const contextFiles = normalizeContextPaths(input.context_files ?? []);
    if (!input.read_only && contextFiles.length > 0) {
      throw new BridgeError(
        "INVALID_ARGUMENT",
        "context_files is only supported for read-only tasks",
      );
    }

    if (!input.read_only && !adapter.supportsWrites) {
      throw new BridgeError(
        "SANDBOX_UNAVAILABLE",
        "This adapter does not support writable tasks; use read_only=true or the mock adapter",
        { details: { adapter: adapter.name } },
      );
    }
    if (
      input.read_only &&
      config.security.read_sandbox === "require" &&
      adapter.supportsReadIsolation !== true
    ) {
      throw new BridgeError(
        "SANDBOX_UNAVAILABLE",
        "Read-only tasks require an OS read sandbox on this host",
        { details: { adapter: adapter.name, platform: process.platform } },
      );
    }

    const repo = await pathPolicy.resolveRepoRoot(input.repo_root, input.read_only);
    const contextEntries =
      contextFiles.length === 0
        ? []
        : await inspectContextFiles(repo.repo_root, contextFiles);
    let gitTopLevel = repo.git_top_level;
    let baseCommit = repo.base_commit;
    if (input.read_only) {
      const git = await pathPolicy.inspectGit(repo.repo_root);
      gitTopLevel = git.top_level;
      baseCommit = git.head;
    }

    const worktreeRequired = !input.read_only && adapter.requiresIsolatedWorktree;
    const contextEnabled = contextFiles.length > 0;
    if (worktreeRequired && baseCommit === null) {
      throw new BridgeError(
        "WORKTREE_CREATE_FAILED",
        `Repository has no HEAD commit: ${repo.repo_root}`,
        { details: { repo_root: repo.repo_root } },
      );
    }

    let mainWorktreeDirty: boolean | null = null;
    let mainWorktreeChanges: string[] = [];
    if (gitTopLevel !== null && this.options.worktrees !== undefined) {
      try {
        const status = await this.options.worktrees.dirtyStatus(repo.repo_root);
        mainWorktreeDirty = status.dirty;
        mainWorktreeChanges = status.files;
      } catch {
        // A missing Git worktree is not fatal for a read-only preflight.
      }
    }

    const capabilities = this.capabilities();
    const warnings: string[] = [];
    if (simulated) {
      warnings.push("Mock adapter: results and tool events are simulated.");
    }
    if (
      !simulated &&
      config.security.read_sandbox === "auto" &&
      adapter.supportsReadIsolation !== true
    ) {
      warnings.push(
        "Read-only tasks will not get OS read isolation on this host; only OpenCode permissions apply.",
      );
    }
    if (worktreeRequired && mainWorktreeDirty === true) {
      warnings.push(
        "The main worktree has uncommitted changes. They are reported, not copied into the isolated worktree.",
      );
    }
    if (worktreeRequired) {
      warnings.push(
        "The isolated worktree is created at task start and will use the new task ID.",
      );
    }
    if (contextEnabled) {
      warnings.push(
        "Only the listed context files are copied into the task workspace; dependencies are not resolved automatically.",
      );
    }
    if (config.security.model_gateway === "off") {
      warnings.push(
        "Model gateway is disabled; OpenCode can read provider credentials and reach the provider network directly.",
      );
    } else if (config.security.model_gateway === "auto") {
      warnings.push(
        "Model gateway auto mode may fall back to direct provider credentials/network for unsupported providers.",
      );
    }

    const unverified = [
      "Provider model availability and quota are checked only when the task starts.",
      "Per-file delegation scope is not enforced; the worker can read anywhere its OS sandbox and tool permissions allow.",
      "The bridge does not run tests or independently verify worker claims.",
      "Cost enforcement requires provider-reported cost.",
      ...capabilities.limitations,
      ...(config.security.model_gateway === "auto"
        ? [
            "Provider compatibility with the local model gateway is verified at task start; auto mode may fall back to direct access.",
          ]
        : config.security.model_gateway === "require"
          ? [
              "Provider compatibility with the local model gateway is verified at task start; unsupported providers fail closed.",
            ]
          : []),
      ...(worktreeRequired
        ? ["Worktree creation and the recorded base commit are verified at task start."]
        : []),
      ...(contextEnabled
        ? ["Context files are hashed now and copied at task start; the snapshot is not yet created."]
        : []),
    ];

    return {
      adapter: adapter.name,
      simulated,
      requested: {
        repo_root: input.repo_root,
        model: input.model ?? null,
        read_only: input.read_only,
      },
      workspace: {
        kind: contextEnabled
          ? "context_snapshot"
          : worktreeRequired
            ? "isolated_worktree"
            : "repo_root",
        repo_root: repo.repo_root,
        git_top_level: gitTopLevel,
        base_commit: baseCommit,
        path: contextEnabled || worktreeRequired ? null : repo.repo_root,
        planned_worktree_root: worktreeRequired
          ? join(resolveDataDir(config), "worktrees")
          : null,
        planned_context_root: contextEnabled
          ? join(resolveDataDir(config), "tasks", "<task-id>", "workspace")
          : null,
        worktree_required: worktreeRequired,
        worktree_ready: !worktreeRequired,
        main_worktree_dirty: mainWorktreeDirty,
        main_worktree_changes: mainWorktreeChanges,
      },
      model: {
        model: model.model,
        provider_id: model.provider_id,
        model_id: model.model_id,
        variant: model.variant,
        permitted: true,
        expensive: model.expensive,
        availability: "unverified_until_start",
      },
      permissions: {
        read: true,
        glob: true,
        grep: true,
        edit: !input.read_only,
        write: !input.read_only,
        patch: !input.read_only,
        shell: false,
        external_directories: false,
        web: false,
        subagent: false,
        question: false,
      },
      isolation: capabilities.execution,
      budgets: {
        max_tokens: config.models.max_tokens,
        max_cost_usd: config.models.max_cost_usd,
        enforcement: "soft",
        hard_limits: ["queue_size", "concurrency", "task_timeout"],
        soft_limits: ["tokens", "cost"],
      },
      timeout_seconds: {
        default: config.scheduler.default_timeout_seconds,
        max: config.scheduler.max_timeout_seconds,
      },
      context: {
        enabled: contextEnabled,
        planned_root: contextEnabled
          ? join(resolveDataDir(config), "tasks", "<task-id>", "workspace")
          : null,
        files: contextEntries,
        total_bytes: contextEntries.reduce((sum, file) => sum + file.bytes, 0),
        note: contextEnabled
          ? "Only the listed files are copied; missing dependencies are not resolved automatically."
          : "No context snapshot requested; the task workspace is the repository root.",
      },
      unverified: [...new Set(unverified)],
      warnings,
    };
  }

  async delivery(options: DeliveryOptions): Promise<DeliveryPackage> {
    const task = this.requireTask(options.task_id);
    const events = this.options.eventStore.list(task.id, { limit: 10_000 }).events;
    const resolved = events
      .filter((event) => event.event_type === "opencode.model.resolved")
      .at(-1);
    const resolvedPayload = resolved?.payload ?? {};
    const actualProvider =
      typeof resolvedPayload.provider_id === "string"
        ? resolvedPayload.provider_id
        : null;
    const actualModelId =
      typeof resolvedPayload.model_id === "string"
        ? resolvedPayload.model_id
        : null;
    const advertised =
      typeof resolvedPayload.advertised_id === "string"
        ? resolvedPayload.advertised_id
        : actualProvider !== null && actualModelId !== null
          ? `${actualProvider}/${actualModelId}`
          : null;

    const diff = await this.diff(task.id, {
      ...(options.max_chars === undefined ? {} : { maxChars: options.max_chars }),
    });
    const simulated = this.options.adapter.name === "mock";
    const patch = diff.available ? diff.patch : "";
    const patchHash =
      patch === "" ? null : createHash("sha256").update(patch).digest("hex");

    const commands = extractDeliveryCommands(events, simulated);
    const context = await readContextManifest(task);
    const findings = parseReviewFindings(finalAssistantText(events));
    const verificationStatus = simulated
      ? "simulated"
      : task.status === "completed"
        ? "unverified"
        : "failed";
    const notes = [
      "The bridge did not execute tests or commands.",
      "Commands below are observed or worker-reported and are not independently verified.",
      "The patch was not applied by the bridge.",
      ...(simulated ? ["Mock adapter output is simulated."] : []),
    ];

    return {
      task_id: task.id,
      status: task.status,
      generated_at: this.now().toISOString(),
      task: {
        task_type: task.task_type,
        repo_root: task.repo_root,
        read_only: task.read_only,
        root_task_id: task.root_task_id,
        turn: task.turn,
        session_id: task.session_id,
      },
      context,
      model: {
        requested: task.model,
        actual: advertised,
        provider_id: actualProvider ?? task.provider_id,
        model_id: actualModelId ?? task.model_id,
        variant: task.model_variant,
        verified: resolved !== undefined,
        simulated,
        gateway: resolvedPayload.gateway === true,
      },
      git: {
        available: diff.available,
        ...(diff.available ? {} : { reason: diff.reason ?? "no_worktree" }),
        base_commit: task.base_commit,
        worktree_path: task.worktree_path,
        status: diff.available ? diff.git_status : "",
        files: diff.files,
        added: diff.added,
        modified: diff.modified,
        deleted: diff.deleted,
        untracked: diff.untracked,
        additions: diff.additions,
        deletions: diff.deletions,
        patch,
        patch_truncated: diff.available ? diff.patch_truncated : false,
        patch_sha256: patchHash,
      },
      commands,
      verification: {
        status: verificationStatus,
        bridge_ran_commands: false,
        tests_run_by_bridge: false,
        notes,
      },
      findings,
      usage: { ...task.usage },
      cost: {
        usd: task.usage.cost_usd,
        known: task.usage.cost_known,
      },
      unverified: [
        "Tests and command results were not executed by the bridge.",
        "Provider model availability and quota were not re-checked.",
        "Patch application and downstream integration were not verified.",
        "Per-file delegation scope was not enforced.",
        ...(task.usage.cost_known ? [] : ["Provider cost was not reported."]),
      ],
    };
  }

  async wait(input: WaitTasksInput, signal?: AbortSignal): Promise<WaitTasksResult> {
    if (input.task_ids.length < 1 || input.task_ids.length > 8 ||
        !Number.isInteger(input.timeout_seconds) || input.timeout_seconds < 0 || input.timeout_seconds > 50) {
      throw new BridgeError("INVALID_ARGUMENT", "wait requires 1-8 task IDs and a timeout of 0-50 seconds");
    }
    const ids = [...new Set(input.task_ids)];
    // Validate every ID before waiting, including when another target is already ready.
    ids.forEach((id) => this.requireTask(id));
    const started = performance.now();
    const timeoutMs = input.timeout_seconds * 1000;
    while (true) {
      signal?.throwIfAborted();
      const tasks = ids.map((id) => this.status(id));
      const ready = tasks.filter((task) => isTerminal(task.status) || task.status === "waiting_permission");
      const elapsed = performance.now() - started;
      if (ready.length > 0 || elapsed >= timeoutMs) {
        return {
          tasks,
          ready_task_ids: ready.map((task) => task.task_id),
          timed_out: ready.length === 0,
          waited_ms: Math.round(elapsed),
        };
      }
      await delay(Math.min(100, timeoutMs - elapsed), undefined, { signal });
    }
  }

  async spawn(input: SpawnTaskInput): Promise<SpawnResult> {
    this.assertProviderReady();
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
    const contextFiles = normalizeContextPaths(input.context_files ?? []);
    if (!input.read_only && contextFiles.length > 0) {
      throw new BridgeError(
        "INVALID_ARGUMENT",
        "context_files is only supported for read-only tasks; writable tasks use an isolated worktree",
      );
    }
    const fingerprint = this.fingerprint({
      ...input,
      task: taskText,
      context_files: contextFiles,
    });
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
    if (contextFiles.length > 0) {
      await inspectContextFiles(repo.repo_root, contextFiles);
    }
    const baseCommit = input.read_only
      ? (await this.options.pathPolicy.inspectGit(repo.repo_root)).head
      : repo.base_commit;

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
      server_pid: null,
      worktree_path: null,
      worktree_git_dir: null,
      base_commit: baseCommit,
      context_path: null,
      context_files: contextFiles,
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
        context_files: contextFiles,
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

  async message(
    taskId: string,
    message: string,
    contextFiles: string[] = [],
  ): Promise<SpawnResult> {
    this.assertProviderReady();
    const text = message.trim();
    if (text.length === 0) {
      throw new BridgeError("INVALID_ARGUMENT", "message must not be empty");
    }
    if (text.length > 100_000) {
      throw new BridgeError("INVALID_ARGUMENT", "message is too large (max 100000 characters)");
    }

    const parent = this.requireTask(taskId);
    const additions = normalizeContextPaths(contextFiles);
    if (!parent.read_only && additions.length > 0) {
      throw new BridgeError(
        "INVALID_ARGUMENT",
        "context_files is only supported for read-only tasks",
      );
    }
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
    const combinedContext = [...new Set([...parent.context_files, ...additions])];
    if (additions.length > 0) {
      await inspectContextFiles(repo.repo_root, combinedContext);
    }
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
      server_pid: null,
      worktree_path: parent.worktree_path,
      worktree_git_dir: parent.worktree_git_dir,
      base_commit: parent.base_commit,
      context_path: additions.length > 0 ? null : parent.context_path,
      context_files: combinedContext,
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
        context_files: additions,
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

  async cleanup(options: CleanupOptions): Promise<CleanupResult> {
    const actions: CleanupAction[] = [];
    const errors: string[] = [];
    const logRetentionDays = this.options.config.cleanup?.log_retention_days ?? 30;
    const worktreeRetentionDays = this.options.config.cleanup?.worktree_retention_days ?? 30;
    const now = this.now().getTime();

    const tasks =
      options.task_ids === undefined
        ? [...this.tasks.values()]
        : options.task_ids.map((id) => this.requireTask(id));

    if (options.include_worktrees) {
      for (const task of tasks) {
        if (task.worktree_path === null) continue;
        if (!isTerminal(task.status)) {
          actions.push({
            kind: "worktree",
            path: task.worktree_path,
            status: "skipped",
            reason: "task_active",
            task_id: task.id,
          });
          continue;
        }

        try {
          const worktrees = this.options.worktrees;
          if (worktrees === undefined) {
            throw new BridgeError("CLEANUP_FAILED", "Worktree manager is not configured");
          }
          const status = await worktrees.dirtyStatus(task.worktree_path);
          if (status.dirty) {
            if (options.dry_run) {
              actions.push({
                kind: "worktree",
                path: task.worktree_path,
                status: "approval_required",
                reason: "worktree_has_changes",
                task_id: task.id,
              });
            } else {
              const approval = this.createApproval("cleanup_worktree", {
                task_id: task.id,
                worktree_path: task.worktree_path,
                repo_root: task.repo_root,
                base_commit: task.base_commit,
              });
              actions.push({
                kind: "worktree",
                path: task.worktree_path,
                status: "approval_required",
                reason: "worktree_has_changes",
                task_id: task.id,
                approval_id: approval.id,
              });
            }
            continue;
          }

          const ended = Date.parse(task.ended_at ?? task.created_at);
          const ageDays = Number.isFinite(ended) ? (now - ended) / 86_400_000 : 0;
          if (options.task_ids === undefined && ageDays < worktreeRetentionDays) {
            actions.push({
              kind: "worktree",
              path: task.worktree_path,
              status: "skipped",
              reason: "retention",
              task_id: task.id,
            });
            continue;
          }

          if (options.dry_run) {
            actions.push({
              kind: "worktree",
              path: task.worktree_path,
              status: "planned",
              reason: "clean_worktree",
              task_id: task.id,
            });
          } else {
            const result = await worktrees.remove(task.worktree_path, task.repo_root);
            if (result.removed) {
              this.recordCleanup("worktree", task.worktree_path, "removed");
              actions.push({
                kind: "worktree",
                path: task.worktree_path,
                status: "removed",
                reason: "clean_worktree",
                task_id: task.id,
              });
            } else {
              actions.push({
                kind: "worktree",
                path: task.worktree_path,
                status: "skipped",
                reason: result.reason ?? "not_removed",
                task_id: task.id,
              });
            }
          }
        } catch (error) {
          errors.push(
            `worktree ${task.worktree_path}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    }

    if (options.include_logs) {
      const logDir = join(resolveDataDir(this.options.config), "logs");
      try {
        const entries = await readdir(logDir, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isFile() || !entry.name.endsWith(".log") || entry.name === "daemon.log") continue;
          const path = join(logDir, entry.name);
          const taskId = entry.name.startsWith("opencode-")
            ? entry.name.slice("opencode-".length, -".log".length)
            : null;
          const task = taskId === null ? undefined : this.tasks.get(taskId);
          if (task !== undefined && !isTerminal(task.status)) continue;
          try {
            const info = await stat(path);
            const ageDays = (now - info.mtimeMs) / 86_400_000;
            if (ageDays < logRetentionDays) continue;
            if (options.dry_run) {
              actions.push({
                kind: "log",
                path,
                status: "planned",
                reason: "log_retention",
                bytes: info.size,
              });
            } else {
              await unlink(path);
              this.recordCleanup("log", path, "removed");
              actions.push({
                kind: "log",
                path,
                status: "removed",
                reason: "log_retention",
                bytes: info.size,
              });
            }
          } catch (error) {
            errors.push(
              `log ${path}: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          errors.push(`log directory: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }

    return { dry_run: options.dry_run, actions, errors };
  }

  async approveCleanup(approvalId: string): Promise<CleanupResult> {
    const approval =
      this.approvals.get(approvalId) ?? this.store?.getApproval(approvalId) ?? null;
    if (approval === null) {
      throw new BridgeError("APPROVAL_NOT_FOUND", `Cleanup approval not found: ${approvalId}`);
    }
    if (approval.kind !== "cleanup_worktree") {
      throw new BridgeError("APPROVAL_NOT_FOUND", `Unsupported approval kind: ${approval.kind}`);
    }
    if (approval.consumed_at !== null) {
      throw new BridgeError("APPROVAL_CONSUMED", `Cleanup approval already consumed: ${approvalId}`);
    }
    if (approval.payload.task_id === undefined || approval.payload.worktree_path === undefined) {
      throw new BridgeError("CLEANUP_FAILED", "Cleanup approval is missing worktree metadata");
    }

    const taskId = String(approval.payload.task_id);
    const worktreePath = String(approval.payload.worktree_path);
    const repoRoot = String(approval.payload.repo_root ?? "");
    const baseCommit = String(approval.payload.base_commit ?? "");
    if (repoRoot === "" || worktreePath === "") {
      throw new BridgeError("CLEANUP_FAILED", "Cleanup approval is missing repository metadata");
    }

    try {
      let patchPath: string | null = null;
      if (baseCommit !== "" && this.options.diffs !== undefined) {
        const diff = await this.options.diffs
          .getDiff({ worktreePath, baseCommit, maxChars: 200_000 })
          .catch(() => null);
        if (diff !== null && diff.patch !== "") {
          const approvalDir = join(resolveDataDir(this.options.config), "approvals");
          await mkdir(approvalDir, { recursive: true, mode: 0o700 });
          patchPath = join(approvalDir, `${approvalId}.patch`);
          await writeFile(patchPath, diff.patch, { mode: 0o600 });
        }
      }

      const removed = await this.options.worktrees?.forceRemove(worktreePath, repoRoot);
      if (removed === undefined || !removed.removed) {
        throw new BridgeError("CLEANUP_FAILED", "Worktree removal was refused", {
          details: { worktree_path: worktreePath, reason: removed?.reason },
        });
      }
      this.store?.consumeApproval(approvalId);
      approval.consumed_at = this.now().toISOString();
      this.approvals.set(approvalId, approval);
      this.recordCleanup("worktree", worktreePath, "approved_removed");
      return {
        dry_run: false,
        actions: [
          {
            kind: "worktree",
            path: worktreePath,
            status: "removed",
            task_id: taskId,
            ...(patchPath === null ? {} : { reason: `patch_saved:${patchPath}` }),
          },
        ],
        errors: [],
      };
    } catch (error) {
      throw new BridgeError("CLEANUP_FAILED", "Approved cleanup failed", {
        cause: error,
        details: { approval_id: approvalId, worktree_path: worktreePath },
      });
    }
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
    while (
      !this.shuttingDown &&
      this.providerPause === null &&
      this.running.size < this.options.config.scheduler.max_concurrent
    ) {
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
        task.server_pid = session.server_pid ?? null;
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
        this.store?.saveSession(task);
        this.store?.saveTask(task);
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
    if (task.read_only && task.context_files.length > 0) {
      if (task.context_path !== null) {
        try {
          await stat(task.context_path);
        } catch (error) {
          throw new BridgeError(
            "CONTEXT_SNAPSHOT_FAILED",
            "Task context snapshot no longer exists",
            {
              cause: error,
              details: { task_id: task.id, context_path: task.context_path },
            },
          );
        }
        return;
      }

      const dataDir = resolveDataDir(this.options.config);
      const contextTaskDir = join(dataDir, "tasks", task.id);
      const destination = join(contextTaskDir, "workspace");
      task.stage = "preparing_context";
      this.append(task, "bridge", "context.snapshot.creating", {
        repo_root: task.repo_root,
        files: task.context_files,
      });

      const snapshot = await writeContextSnapshot({
        repoRoot: task.repo_root,
        files: task.context_files,
        destination,
      });
      const manifestPath = join(contextTaskDir, "context-manifest.json");
      await writeFile(
        manifestPath,
        JSON.stringify(
          {
            created_at: this.now().toISOString(),
            repo_root: task.repo_root,
            workspace: destination,
            files: snapshot.files,
            total_bytes: snapshot.total_bytes,
          },
          null,
          2,
        ),
        { mode: 0o600 },
      );
      task.context_path = destination;
      this.store?.saveTask(task);
      this.append(task, "bridge", "context.snapshot.created", {
        workspace: destination,
        manifest_path: manifestPath,
        files: snapshot.files,
        total_bytes: snapshot.total_bytes,
      });
      return;
    }

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
    this.store?.saveWorktree(task);
    this.store?.saveTask(task);

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

    if (handle.stopReason === "budget" || this.budgetExceeded(usage)) {
      this.finalize(task, "failed", {
        summary: result.summary,
        usage,
        error: { code: "BUDGET_EXCEEDED", message: "Task exceeded its configured token or cost budget" },
      });
      return;
    }

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
    if (
      payload.code === "PROVIDER_AUTH_FAILED" ||
      payload.code === "PROVIDER_QUOTA_EXCEEDED" ||
      payload.code === "REGION_RESTRICTED"
    ) {
      this.pauseProvider(payload.code, payload.message);
    }

    if (handle.stopReason === "budget") {
      this.finalize(task, "failed", {
        summary: null,
        usage: task.usage,
        error: { code: "BUDGET_EXCEEDED", message: "Task exceeded its configured token or cost budget" },
      });
      return;
    }

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
    this.store?.saveUsage(task);
    this.store?.saveTask(task);

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
    reason: "abort" | "timeout" | "budget",
  ): Promise<boolean> {
    if (handle.stopReason === null) handle.stopReason = reason;
    if (task.stop_reason === null) task.stop_reason = reason;

    if (
      (reason === "abort" || reason === "budget") &&
      !isTerminal(task.status) &&
      task.status !== "cancelling"
    ) {
      const previousStatus = task.status;
      this.setStatus(task, "cancelling", "cancelling");
      task.cancel_requested_at = this.now().toISOString();
      this.append(task, "bridge", "task.cancelling", {
        reason: reason === "budget" ? "budget_exceeded" : "user_abort",
        previous_status: previousStatus,
      });
    }

    if (reason === "timeout") {
      this.append(task, "bridge", "task.timeout_requested", {
        timeout_seconds: task.timeout_seconds,
      });
    }

    if (reason === "budget") {
      this.append(task, "system", "task.budget_exceeded", {
        usage: task.usage,
        max_tokens: this.options.config.models.max_tokens,
        max_cost_usd: this.options.config.models.max_cost_usd,
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
    // Assistant replies are conversation content, not compact audit metadata.
    // Keep them up to the delegation limit so the viewer can show the full answer.
    this.append(
      task,
      event.source,
      event.event_type,
      event.payload,
      event.event_type === "opencode.message"
        ? { maxPayloadChars: this.options.config.history.max_delegation_chars }
        : undefined,
    );

    if (event.event_type === "usage.updated") {
      const usage = parseUsage(event.payload.usage);
      if (usage !== null) {
        task.usage = usage;
        this.store?.saveUsage(task);
        if (this.budgetExceeded(usage)) {
          const handle = this.running.get(task.id);
          if (handle !== undefined && handle.stopReason === null) {
            void this.requestStop(task, handle, "budget").catch((error: unknown) => {
              this.options.logger.error(
                { task_id: task.id, error: toErrorPayload(error) },
                "budget stop request failed",
              );
            });
          }
        }
      }
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
    this.persistEvent(task, event);
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
    this.store?.saveTask(task);
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
      context_path: task.context_path,
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

  private persistEvent(task: TaskRecord, event: BridgeEvent): void {
    if (this.store === undefined) return;
    try {
      this.store.saveTask(task);
      this.store.appendEvent(event);
      this.store.saveTask(task);
    } catch (error) {
      this.options.logger.error(
        { task_id: task.id, error: toErrorPayload(error) },
        "failed to persist event",
      );
      throw new BridgeError("STORAGE_ERROR", "Failed to persist task event", {
        cause: error,
        details: { task_id: task.id, sequence: event.sequence },
      });
    }
  }

  private recoverFromStore(): void {
    const store = this.store;
    if (store === undefined) return;
    try {
      const tasks = store.loadTasks();
      const events = store.loadEvents();
      this.options.eventStore.hydrate(events);
      for (const task of tasks) {
        this.tasks.set(task.id, task);
        if (task.idempotency_key !== null) this.idempotency.set(task.idempotency_key, task.id);
      }

      for (const task of tasks) {
        if (isTerminal(task.status)) continue;
        const previousStatus = task.status;
        if (task.server_pid !== null) {
          killProcessGroup(task.server_pid);
        }
        task.status = "interrupted";
        task.stage = "interrupted";
        task.ended_at = this.now().toISOString();
        task.error_code = "SESSION_LOST";
        task.error_message = "Bridge daemon restarted before the task completed";
        task.stop_reason = null;
        this.append(task, "system", "task.interrupted", {
          reason: "daemon_restart",
          previous_status: previousStatus,
          server_pid: task.server_pid,
        });
        this.store?.saveTask(task);
      }
      this.options.logger.info(
        { recovered_tasks: tasks.length, recovered_events: events.length },
        "task state recovered from SQLite",
      );
    } catch (error) {
      throw new BridgeError("STORAGE_ERROR", "Failed to recover task state from SQLite", {
        cause: error,
      });
    }
  }

  private createApproval(kind: string, payload: Record<string, unknown>): ApprovalRecord {
    const approval: ApprovalRecord = {
      id: `approval_${randomUUID()}`,
      kind,
      payload,
      created_at: this.now().toISOString(),
      consumed_at: null,
    };
    this.approvals.set(approval.id, approval);
    this.store?.saveApproval(approval);
    return approval;
  }

  private recordCleanup(kind: string, path: string, result: string): void {
    this.store?.saveCleanupRecord({
      id: `cleanup_${randomUUID()}`,
      kind,
      path,
      result,
    });
  }

  resumeProvider(): { resumed: boolean } {
    const wasPaused = this.providerPause !== null;
    this.providerPause = null;
    if (wasPaused) {
      this.options.logger.info("provider pause cleared by local CLI");
      this.pump();
    }
    return { resumed: wasPaused };
  }

  private assertProviderReady(): void {
    if (this.providerPause === null) return;
    throw new BridgeError(
      "PROVIDER_PAUSED",
      `Delegation is paused after ${this.providerPause.code}: ${this.providerPause.message}`,
      { details: { ...this.providerPause } },
    );
  }

  private pauseProvider(code: string, message: string): void {
    if (this.providerPause !== null) return;
    this.providerPause = {
      code,
      message,
      at: this.now().toISOString(),
    };
    this.options.logger.warn(
      { code, message },
      "provider/account error paused new delegations",
    );
  }

  private budgetExceeded(usage: TaskUsage): boolean {
    const maxTokens = this.options.config.models.max_tokens;
    if (maxTokens !== null && usage.total_tokens > maxTokens) return true;
    const maxCost = this.options.config.models.max_cost_usd;
    if (
      maxCost !== null &&
      usage.cost_known &&
      usage.cost_usd !== null &&
      usage.cost_usd > maxCost
    ) {
      return true;
    }
    return false;
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
          context_files: input.context_files ?? [],
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

function finalAssistantText(events: BridgeEvent[]): string | null {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index];
    if (event === undefined || event.event_type !== "opencode.message") continue;
    const payload = asRecord(event.payload);
    if (stringField(payload, "role") !== "assistant") continue;
    const text = stringField(payload, "text");
    if (text !== null && text.trim() !== "") return text;
    const preview = stringField(payload, "preview");
    if (preview !== null && preview.trim() !== "") {
      try {
        const parsed = JSON.parse(preview) as { text?: unknown };
        if (typeof parsed.text === "string" && parsed.text.trim() !== "") return parsed.text;
      } catch {
        return preview;
      }
    }
  }
  return null;
}

async function readContextManifest(
  task: TaskRecord,
): Promise<DeliveryPackage["context"]> {
  if (task.context_path === null) {
    return {
      path: null,
      manifest_path: null,
      files: [],
      total_bytes: 0,
      verified: false,
    };
  }
  const manifestPath = join(dirname(task.context_path), "context-manifest.json");
  try {
    const parsed = JSON.parse(await readFile(manifestPath, "utf8")) as {
      files?: unknown;
      total_bytes?: unknown;
    };
    const files = Array.isArray(parsed.files)
      ? parsed.files.filter(
          (file): file is ContextFile =>
            typeof file === "object" &&
            file !== null &&
            typeof (file as ContextFile).path === "string" &&
            typeof (file as ContextFile).sha256 === "string" &&
            typeof (file as ContextFile).bytes === "number",
        )
      : [];
    return {
      path: task.context_path,
      manifest_path: manifestPath,
      files,
      total_bytes:
        typeof parsed.total_bytes === "number"
          ? parsed.total_bytes
          : files.reduce((sum, file) => sum + file.bytes, 0),
      verified: files.length > 0,
    };
  } catch {
    return {
      path: task.context_path,
      manifest_path: manifestPath,
      files: [],
      total_bytes: 0,
      verified: false,
    };
  }
}

function extractDeliveryCommands(
  events: BridgeEvent[],
  simulated: boolean,
): DeliveryCommand[] {
  const commands = new Map<string, DeliveryCommand>();
  for (const event of events) {
    const payload = asRecord(event.payload);
    const input = asRecord(payload.input);
    const callId =
      stringField(payload, "call_id") ??
      stringField(payload, "callId") ??
      stringField(payload, "id");
    const key = `${event.task_id}:${callId ?? event.sequence}`;

    if (event.event_type === "shell.started") {
      commands.set(key, {
        command: stringField(payload, "command") ?? stringField(input, "command"),
        exit_code: null,
        source: simulated ? "simulated" : "shell",
        observed_at: event.timestamp,
        verified_by_bridge: false,
        note: "Reported by OpenCode; not executed by the bridge.",
      });
      continue;
    }

    if (event.event_type === "shell.ended") {
      const exitCode =
        numberField(payload, "exitCode") ??
        numberField(payload, "exit_code") ??
        numberField(payload, "code");
      const existing = commands.get(key);
      if (existing !== undefined) {
        existing.exit_code = exitCode;
      } else {
        commands.set(key, {
          command: null,
          exit_code: exitCode,
          source: simulated ? "simulated" : "shell",
          observed_at: event.timestamp,
          verified_by_bridge: false,
          note: "Reported by OpenCode; not executed by the bridge.",
        });
      }
      continue;
    }

    if (event.event_type !== "tool.called") continue;
    const tool = stringField(payload, "tool");
    const command = stringField(input, "command") ?? stringField(payload, "command");
    if (tool !== "bash" && tool !== "shell" && command === null) continue;
    commands.set(key, {
      command,
      exit_code: null,
      source: simulated ? "simulated" : "tool",
      observed_at: event.timestamp,
      verified_by_bridge: false,
      note:
        stringField(payload, "note") ??
        "Worker-reported tool command; not executed by the bridge.",
    });
  }
  return [...commands.values()].sort((a, b) =>
    a.observed_at.localeCompare(b.observed_at),
  );
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" ? value : null;
}

function numberField(record: Record<string, unknown>, key: string): number | null {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function killProcessGroup(pid: number): void {
  try {
    process.kill(pid, 0);
  } catch {
    return;
  }
  try {
    if (process.platform === "win32") {
      process.kill(pid, "SIGTERM");
    } else {
      process.kill(-pid, "SIGTERM");
    }
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Process already exited.
    }
  }
}
