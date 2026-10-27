import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { mkdir, readFile, readdir, realpath, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import type { BridgeConfig } from "../config.js";
import type { DiffManager } from "../git/diff-manager.js";
import type { TaskDiffResult, TaskHistoryResult } from "./task-service.js";
import type { SqliteStore } from "../storage/sqlite-store.js";
import { resolveDataDir } from "../paths.js";
import type { WorktreeManager } from "../git/worktree-manager.js";
import { BridgeError, isBridgeError, toErrorPayload } from "../errors.js";
import type { Logger } from "../logging.js";
import { buildInfo } from "../build-info.js";
import { isProviderPattern, type ModelPolicy } from "../policy/model-policy.js";
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
  WaitEventsInput,
  WaitEventsResult,
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
  normalizeRepoPaths,
  writeContextSnapshot,
} from "./context-snapshot.js";
import { parseReviewFindings } from "./findings.js";
import {
  readDeliverySnapshot,
  writeDeliverySnapshot,
  type DeliverySnapshot,
} from "./delivery-snapshot.js";
import { DEFAULT_PROTECTED_PATHS, scopeViolations, type PathContract } from "./path-contract.js";

interface RunHandle {
  controller: AbortController;
  session: AdapterSession | null;
  stopReason: "abort" | "timeout" | "budget" | null;
  abortConfirmed: boolean | null;
  executionSucceeded: boolean;
}

const MAX_TIMER_DELAY_MS = 2_147_483_647;
const SNAPSHOT_MAX_PATCH_CHARS = 10_000_000;

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
  private readonly budgetThresholds = new Map<string, number>();
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
      build: {
        ...buildInfo(),
        config_path: config.config_path ?? null,
        config_revision: config.config_revision ?? null,
      },
      models: {
        default: config.models.default,
        allowed: config.models.allow.map((model) => {
          try {
            if (!isProviderPattern(model)) modelPolicy.resolve(model);
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
      limitations: [
        ...(simulated
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
            ]),
        config.scheduler.default_timeout_seconds === 0
          ? "Task execution has no automatic timeout; use agent_abort to stop a running task."
          : `New tasks receive a ${config.scheduler.default_timeout_seconds}s default hard timeout; pass timeout_seconds: 0 to disable it.`,
      ],
    };
  }

  private policySnapshot(): Record<string, unknown> {
    const { config, adapter } = this.options;
    return {
      config_revision: config.config_revision ?? null,
      adapter: adapter.name,
      model_gateway: config.security.model_gateway,
      read_sandbox: config.security.read_sandbox,
      max_tokens: config.models.max_tokens,
      max_cost_usd: config.models.max_cost_usd,
      default_timeout_seconds: config.scheduler.default_timeout_seconds,
      max_timeout_seconds: config.scheduler.max_timeout_seconds,
    };
  }

  private async resolveManagedWorkspace(
    sourceTaskId: string,
    requestedRepoRoot: string,
    readOnly: boolean,
  ): Promise<{
    repo_root: string;
    git_top_level: string | null;
    base_commit: string | null;
    workspace_path: string;
  }> {
    if (!readOnly) {
      throw new BridgeError(
        "INVALID_ARGUMENT",
        "workspace_from_task_id is read-only; use agent_message to continue a writable lineage",
      );
    }
    const source = this.requireTask(sourceTaskId);
    if (!isTerminal(source.status)) {
      throw new BridgeError("TASK_BUSY", "Source task is still active", {
        details: { source_task_id: sourceTaskId, status: source.status },
      });
    }
    const requested = await this.options.pathPolicy.resolveRepoRoot(requestedRepoRoot, true);
    if (requested.repo_root !== source.repo_root) {
      throw new BridgeError(
        "INVALID_ARGUMENT",
        "workspace_from_task_id belongs to a different repository",
        {
          details: {
            source_task_id: sourceTaskId,
            source_repo_root: source.repo_root,
            requested_repo_root: requested.repo_root,
          },
        },
      );
    }
    const recorded = source.worktree_path ?? source.context_path ?? source.workspace_path;
    if (recorded === null) {
      throw new BridgeError(
        "INVALID_ARGUMENT",
        "Source task has no reusable managed workspace",
        { details: { source_task_id: sourceTaskId } },
      );
    }
    const workspace = await realpath(recorded).catch((error: unknown) => {
      throw new BridgeError("REPO_NOT_FOUND", "Managed workspace no longer exists", {
        cause: error,
        details: { source_task_id: sourceTaskId, workspace: recorded },
      });
    });
    const dataDir = resolveDataDir(this.options.config);
    const managed =
      isWithinPath(join(dataDir, "worktrees"), workspace) ||
      isWithinPath(join(dataDir, "tasks"), workspace);
    if (!managed || workspace !== recorded) {
      throw new BridgeError(
        "INVALID_ARGUMENT",
        "Workspace is not owned by this Bridge task",
        { details: { source_task_id: sourceTaskId, workspace } },
      );
    }
    const info = await stat(workspace);
    if (!info.isDirectory()) {
      throw new BridgeError("REPO_NOT_FOUND", "Managed workspace is not a directory", {
        details: { source_task_id: sourceTaskId, workspace },
      });
    }
    return {
      repo_root: source.repo_root,
      git_top_level: source.repo_root,
      base_commit: source.base_commit,
      workspace_path: workspace,
    };
  }

  async preflight(input: PreflightInput): Promise<PreflightResult> {
    this.assertProviderReady();
    const { config, adapter, modelPolicy, pathPolicy } = this.options;
    const simulated = adapter.name === "mock";
    const model = modelPolicy.resolve(input.model);
    const contextFiles = normalizeContextPaths(input.context_files ?? []);
    const readPaths = normalizeRepoPaths(input.read_paths ?? [], "read_paths");
    const writePaths = normalizeRepoPaths(input.write_paths ?? [], "write_paths");
    if (!input.read_only && contextFiles.length > 0) {
      throw new BridgeError(
        "INVALID_ARGUMENT",
        "context_files is only supported for read-only tasks",
      );
    }
    if (input.read_only && writePaths.length > 0) {
      throw new BridgeError(
        "INVALID_ARGUMENT",
        "write_paths is only supported for writable tasks",
      );
    }
    if (input.workspace_from_task_id !== undefined && contextFiles.length > 0) {
      throw new BridgeError(
        "INVALID_ARGUMENT",
        "workspace_from_task_id cannot be combined with context_files",
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

    const managedWorkspace =
      input.workspace_from_task_id === undefined
        ? null
        : await this.resolveManagedWorkspace(
            input.workspace_from_task_id,
            input.repo_root,
            input.read_only,
          );
    const repo = managedWorkspace ?? await pathPolicy.resolveRepoRoot(input.repo_root, input.read_only);
    const contextEntries =
      contextFiles.length === 0
        ? []
        : await inspectContextFiles(repo.repo_root, contextFiles);
    let gitTopLevel = repo.git_top_level;
    let baseCommit = repo.base_commit;
    if (managedWorkspace !== null) {
      gitTopLevel = managedWorkspace.git_top_level;
      baseCommit = managedWorkspace.base_commit;
    } else if (input.read_only) {
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
    if (!input.read_only && worktreeRequired) {
      if (writePaths.length === 0) {
        warnings.push(
          "No write_paths were supplied; the worker may edit any file in the isolated worktree.",
        );
      } else {
        warnings.push(
          "write_paths is enforced by OpenCode edit permissions and a post-run diff check; a violation fails the task and preserves the worktree.",
        );
      }
      if (readPaths.length > 0) {
        warnings.push(
          "read_paths is reported for review; reads outside it may still be possible for dependencies.",
        );
      }
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
      ...(writePaths.length > 0
        ? [
            "write_paths is checked against the final diff; writes are not prevented mid-turn by the bridge.",
          ]
        : [
            "Per-file delegation scope is not enforced; the worker can read anywhere its OS sandbox and tool permissions allow.",
          ]),
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
        kind: managedWorkspace !== null
          ? "managed_workspace"
          : contextEnabled
            ? "context_snapshot"
            : worktreeRequired
              ? "isolated_worktree"
              : "repo_root",
        repo_root: repo.repo_root,
        git_top_level: gitTopLevel,
        base_commit: baseCommit,
        path: managedWorkspace !== null
          ? managedWorkspace.workspace_path
          : contextEnabled || worktreeRequired
            ? null
            : repo.repo_root,
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
      path_policy: {
        per_file_scope: writePaths.length > 0,
        read_paths: readPaths,
        write_paths: writePaths,
        enforced_by:
          writePaths.length > 0
            ? "opencode_permissions_and_diff_check"
            : "whole_worktree",
        protected_paths: [...DEFAULT_PROTECTED_PATHS],
      },
      isolation: capabilities.execution,
      budgets: {
        max_tokens: config.models.max_tokens,
        max_cost_usd: config.models.max_cost_usd,
        enforcement: "soft",
        hard_limits: [
          "queue_size",
          "concurrency",
          ...(config.scheduler.default_timeout_seconds > 0 ? ["task_timeout"] : []),
        ],
        soft_limits: ["tokens", "cost"],
      },
      timeout_seconds: {
        default: config.scheduler.default_timeout_seconds,
        max: config.scheduler.max_timeout_seconds,
        automatic_timeout: config.scheduler.default_timeout_seconds > 0,
        zero_means: "no_automatic_timeout",
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

    const dataDir = resolveDataDir(this.options.config);
    const snapshot = await readDeliverySnapshot(dataDir, task.id);
    let diff: TaskDiffResult;
    let source: "snapshot" | "live" | "unavailable";
    let capturedAt: string | null = null;
    if (snapshot !== null) {
      diff = { task_id: task.id, ...snapshot.diff };
      source = "snapshot";
      capturedAt = snapshot.captured_at;
    } else {
      try {
        diff = await this.diff(task.id, { maxChars: SNAPSHOT_MAX_PATCH_CHARS });
        source = diff.available ? "live" : "unavailable";
      } catch {
        diff = unavailableTaskDiff(task, "workspace_removed");
        source = "unavailable";
      }
    }

    const simulated = this.options.adapter.name === "mock";
    const includePatch = options.include_patch !== false;
    const displayed = includePatch
      ? truncatePatch(diff.patch, options.max_chars ?? 40_000)
      : { patch: "", truncated: false };
    const displayPatch = diff.available ? displayed.patch : "";
    const displayPatchHash =
      displayPatch === ""
        ? null
        : createHash("sha256").update(displayPatch).digest("hex");
    const truncationReason = combineTruncation(
      diff.available && includePatch ? displayed.truncated : false,
      diff.available ? diff.truncation_reason : null,
    );
    const usage = snapshot?.usage ?? task.usage;
    const sessionUsage = snapshot?.session_usage ?? latestSessionUsage(events);
    const executionCompleted =
      events.some((event) => event.event_type === "opencode.execution.succeeded") ||
      finalAssistantText(events) !== null ||
      task.status === "completed";
    const artifactAvailable =
      executionCompleted ||
      (diff.available && (diff.files.length > 0 || diff.patch !== ""));
    const budgetEvent = events
      .filter((event) => event.event_type === "task.budget_exceeded")
      .at(-1)?.payload ?? null;
    const policySnapshot = events
      .filter((event) => event.payload.policy !== undefined)
      .at(-1)?.payload.policy;
    const policy = typeof policySnapshot === "object" && policySnapshot !== null
      ? (policySnapshot as Record<string, unknown>)
      : null;
    const policyTokens = limitField(policy, "max_tokens");
    const budgetTokens = limitField(budgetEvent, "max_tokens");
    const policyCost = limitField(policy, "max_cost_usd");
    const budgetCost = limitField(budgetEvent, "max_cost_usd");
    const effectiveMaxTokens = policyTokens.found
      ? policyTokens.value
      : budgetTokens.found
        ? budgetTokens.value
        : this.options.config.models.max_tokens;
    const effectiveMaxCost = policyCost.found
      ? policyCost.value
      : budgetCost.found
        ? budgetCost.value
        : this.options.config.models.max_cost_usd;
    const budgetExceeded =
      task.error_code === "BUDGET_EXCEEDED" ||
      budgetEvent !== null ||
      (effectiveMaxTokens !== null && usage.total_tokens > effectiveMaxTokens) ||
      (effectiveMaxCost !== null &&
        usage.cost_known &&
        usage.cost_usd !== null &&
        usage.cost_usd > effectiveMaxCost);

    const commands = extractDeliveryCommands(events, simulated);
    const context = await readContextManifest(task, dataDir);
    const scopeViolationPayload = events
      .filter((event) => event.event_type === "task.scope_violation")
      .at(-1)?.payload;
    const scopeViolations =
      Array.isArray(scopeViolationPayload?.violations)
        ? scopeViolationPayload.violations.filter(
            (value): value is string => typeof value === "string",
          )
        : [];
    const serverStarted = events
      .filter((event) => event.event_type === "opencode.server.started")
      .at(-1)?.payload;
    const opencodeVersion =
      typeof serverStarted?.version === "string" ? serverStarted.version : null;
    const runtimeBuild = buildInfo();
    const findings = parseReviewFindings(finalAssistantText(events));
    const verificationStatus = simulated
      ? "simulated"
      : task.status === "completed" || executionCompleted
        ? "unverified"
        : "failed";
    const notes = [
      "The bridge did not execute tests or commands.",
      "Commands below are observed or worker-reported and are not independently verified.",
      "The patch was not applied by the bridge.",
      ...(budgetExceeded
        ? [
            "The task exceeded the local soft token/cost budget; artifacts produced before the limit are preserved but not verified.",
          ]
        : []),
      ...(scopeViolations.length > 0
        ? [
            "The worker changed files outside the declared write_paths; the worktree is preserved for review.",
          ]
        : []),
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
        ...(diff.available
          ? {}
          : { reason: diff.reason ?? "no_worktree" }),
        source,
        captured_at: capturedAt,
        base_commit: diff.base_commit ?? task.base_commit,
        worktree_path: diff.worktree_path ?? task.worktree_path,
        status: diff.available ? diff.git_status : "",
        files: diff.files,
        added: diff.added,
        modified: diff.modified,
        deleted: diff.deleted,
        untracked: diff.untracked,
        additions: diff.additions,
        deletions: diff.deletions,
        patch: displayPatch,
        patch_included: includePatch && diff.available,
        patch_truncated: truncationReason !== null,
        patch_sha256: diff.available ? diff.full_patch_sha256 : null,
        patch_bytes: diff.available ? diff.full_patch_bytes : 0,
        display_patch_sha256: displayPatchHash,
        complete_file_count: diff.complete_file_count,
        returned_file_count: diff.returned_file_count,
        omitted_files: diff.omitted_files,
        full_patch_complete: diff.full_patch_complete,
        truncation_reason: truncationReason,
      },
      commands,
      verification: {
        status: verificationStatus,
        bridge_ran_commands: false,
        tests_run_by_bridge: false,
        notes,
      },
      findings,
      policy_snapshot:
        typeof policySnapshot === "object" && policySnapshot !== null
          ? (policySnapshot as Record<string, unknown>)
          : null,
      runtime: {
        bridge_version: runtimeBuild.version,
        bridge_git_sha: runtimeBuild.git_sha,
        opencode_version: opencodeVersion,
        config_revision:
          typeof policySnapshot === "object" &&
          policySnapshot !== null &&
          typeof (policySnapshot as Record<string, unknown>).config_revision === "string"
            ? ((policySnapshot as Record<string, unknown>).config_revision as string)
            : this.options.config.config_revision ?? null,
      },
      path_policy: {
        per_file_scope: task.write_paths.length > 0,
        read_paths: [...task.read_paths],
        write_paths: [...task.write_paths],
        scope_violations: scopeViolations,
      },
      budget: {
        scope: "turn",
        enforcement: "soft",
        max_tokens: effectiveMaxTokens,
        max_cost_usd: effectiveMaxCost,
        exceeded: budgetExceeded,
      },
      artifacts: {
        execution_completed: executionCompleted,
        artifact_available: artifactAvailable,
        worktree_available: diff.available,
        session_usage_recorded: sessionUsage !== null,
      },
      usage: { ...usage },
      session_usage: sessionUsage === null ? null : { ...sessionUsage },
      usage_scope: "turn",
      session_usage_scope: "session",
      cost: {
        usd: usage.cost_usd,
        known: usage.cost_known,
      },
      unverified: [
        "Tests and command results were not executed by the bridge.",
        "Provider model availability and quota were not re-checked.",
        "Patch application and downstream integration were not verified.",
        ...(task.write_paths.length === 0
          ? ["Per-file delegation scope was not enforced."]
          : ["write_paths was checked against the final diff, not enforced mid-turn."]),
        ...(usage.cost_known ? [] : ["Provider cost was not reported."]),
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

  async waitForEvents(
    input: WaitEventsInput,
    signal?: AbortSignal,
  ): Promise<WaitEventsResult> {
    const task = this.requireTask(input.task_id);
    if (
      !Number.isInteger(input.after) ||
      input.after < 0 ||
      !Number.isInteger(input.timeout_seconds) ||
      input.timeout_seconds < 0 ||
      input.timeout_seconds > 50 ||
      !Number.isInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > 100
    ) {
      throw new BridgeError(
        "INVALID_ARGUMENT",
        "events wait requires after>=0, timeout 0-50 seconds, and limit 1-100",
      );
    }
    const started = performance.now();
    const timeoutMs = input.timeout_seconds * 1000;
    while (true) {
      signal?.throwIfAborted();
      const page = this.options.eventStore.list(task.id, {
        after: input.after,
        limit: input.limit,
      });
      const elapsed = performance.now() - started;
      if (page.events.length > 0) {
        return {
          events: page.events,
          next_after: page.events.at(-1)?.sequence ?? input.after,
          timed_out: false,
          task_terminal: isTerminal(task.status),
          waited_ms: Math.round(elapsed),
        };
      }
      if (isTerminal(task.status)) {
        return {
          events: [],
          next_after: input.after,
          timed_out: false,
          task_terminal: true,
          waited_ms: Math.round(elapsed),
        };
      }
      if (elapsed >= timeoutMs) {
        return {
          events: [],
          next_after: input.after,
          timed_out: true,
          task_terminal: false,
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
      timeoutSeconds < 0 ||
      timeoutSeconds > this.options.config.scheduler.max_timeout_seconds
    ) {
      throw new BridgeError(
        "INVALID_ARGUMENT",
        `timeout_seconds must be between 0 and ${this.options.config.scheduler.max_timeout_seconds}; 0 disables the automatic execution timeout`,
        { details: { timeout_seconds: timeoutSeconds } },
      );
    }

    const idempotencyKey = input.idempotency_key?.trim() || null;
    const contextFiles = normalizeContextPaths(input.context_files ?? []);
    const readPaths = normalizeRepoPaths(input.read_paths ?? [], "read_paths");
    const writePaths = normalizeRepoPaths(input.write_paths ?? [], "write_paths");
    if (!input.read_only && contextFiles.length > 0) {
      throw new BridgeError(
        "INVALID_ARGUMENT",
        "context_files is only supported for read-only tasks; writable tasks use an isolated worktree",
      );
    }
    if (input.read_only && writePaths.length > 0) {
      throw new BridgeError(
        "INVALID_ARGUMENT",
        "write_paths is only supported for writable tasks",
      );
    }
    if (input.workspace_from_task_id !== undefined && contextFiles.length > 0) {
      throw new BridgeError(
        "INVALID_ARGUMENT",
        "workspace_from_task_id cannot be combined with context_files",
      );
    }
    const fingerprint = this.fingerprint({
      ...input,
      task: taskText,
      context_files: contextFiles,
      read_paths: readPaths,
      write_paths: writePaths,
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
    const managedWorkspace =
      input.workspace_from_task_id === undefined
        ? null
        : await this.resolveManagedWorkspace(
            input.workspace_from_task_id,
            input.repo_root,
            input.read_only,
          );
    const repo = managedWorkspace ?? await this.options.pathPolicy.resolveRepoRoot(input.repo_root, input.read_only);
    if (contextFiles.length > 0) {
      await inspectContextFiles(repo.repo_root, contextFiles);
    }
    const baseCommit = managedWorkspace !== null
      ? managedWorkspace.base_commit
      : input.read_only
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
      workspace_path: managedWorkspace?.workspace_path ?? null,
      context_files: contextFiles,
      read_paths: readPaths,
      write_paths: writePaths,
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
        read_paths: readPaths,
        write_paths: writePaths,
        policy: this.policySnapshot(),
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
    if (additions.length > 0 && parent.context_path === null) {
      throw new BridgeError("INVALID_ARGUMENT", "Start a new task with context_files to enable snapshot isolation");
    }
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
      context_path: parent.context_path,
      workspace_path: parent.workspace_path,
      context_files: combinedContext,
      read_paths: parent.read_paths,
      write_paths: parent.write_paths,
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
        policy: this.policySnapshot(),
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
    const worktreePath =
      task.worktree_path ??
      (task.workspace_path !== null && task.base_commit !== null
        ? task.workspace_path
        : null);
    if (worktreePath === null || task.base_commit === null) {
      return {
        task_id: task.id,
        reason: "no_worktree",
        available: false,
        worktree_path: worktreePath,
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
        full_patch_sha256: null,
        full_patch_bytes: 0,
        complete_file_count: 0,
        returned_file_count: 0,
        omitted_files: [],
        full_patch_complete: false,
        truncation_reason: null,
      };
    }
    if (this.options.diffs === undefined) {
      throw new BridgeError("WORKTREE_CREATE_FAILED", "Diff manager is not configured");
    }
    const result = await this.options.diffs.getDiff({
      worktreePath,
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
      executionSucceeded: false,
    };
    this.running.set(task.id, handle);
    task.started_at = this.now().toISOString();

    this.setStatus(task, "preparing", "preparing");
    this.append(task, "bridge", "task.started", {
      started_at: task.started_at,
      timeout_seconds: task.timeout_seconds,
    });

    // timeout_seconds === 0 means caller-controlled lifetime. Only an explicit
    // positive deadline creates an automatic stop; agent_abort always works.
    // Node timers cap at 2^31-1 ms, so long deadlines are rescheduled in chunks.
    let timeoutTimer: NodeJS.Timeout | null = null;
    if (task.timeout_seconds > 0) {
      const deadline = Date.now() + task.timeout_seconds * 1000;
      const scheduleTimeout = (): void => {
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          timeoutTimer = null;
          void this.requestStop(task, handle, "timeout").catch((error: unknown) => {
            this.options.logger.error(
              { task_id: task.id, error: toErrorPayload(error) },
              "timeout stop request failed",
            );
          });
          return;
        }
        timeoutTimer = setTimeout(
          scheduleTimeout,
          Math.min(remaining, MAX_TIMER_DELAY_MS),
        );
      };
      scheduleTimeout();
    }

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
      if (timeoutTimer !== null) {
        clearTimeout(timeoutTimer);
        timeoutTimer = null;
      }
      const usage = bestUsage(result.usage, task.usage);
      const latestSession = latestSessionUsage(
        this.options.eventStore.list(task.id, { limit: 10_000 }).events,
      );
      const sessionUsage =
        result.session_usage === undefined
          ? latestSession
          : bestUsage(result.session_usage, latestSession ?? emptyUsage());
      if (handle.stopReason === null && result.stopped !== true) {
        try {
          const violations = await this.scopeViolation(task);
          if (violations !== null) {
            this.append(task, "bridge", "task.scope_violation", {
              violations,
              write_paths: task.write_paths,
              read_paths: task.read_paths,
            });
            await this.captureDeliverySnapshot(task, usage, sessionUsage);
            this.finalize(task, "failed", {
              summary: result.summary,
              usage,
              error: {
                code: "SCOPE_VIOLATION",
                message: `Worker changed paths outside write_paths: ${violations.join(", ")}`,
              },
            });
            return;
          }
        } catch (error) {
          await this.captureDeliverySnapshot(task, usage, sessionUsage);
          const payload = toErrorPayload(error);
          this.finalize(task, "failed", {
            summary: result.summary,
            usage,
            error: { code: "SCOPE_VIOLATION", message: payload.message },
          });
          return;
        }
      }
      await this.captureDeliverySnapshot(task, usage, sessionUsage);
      this.finishRun(task, handle, result);
    } catch (error) {
      if (timeoutTimer !== null) {
        clearTimeout(timeoutTimer);
        timeoutTimer = null;
      }
      await this.captureDeliverySnapshot(
        task,
        task.usage,
        latestSessionUsage(this.options.eventStore.list(task.id, { limit: 10_000 }).events),
      );
      this.finishRunWithError(task, handle, error);
    } finally {
      if (timeoutTimer !== null) clearTimeout(timeoutTimer);
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
        // Keep the session's execution directory stable. Add only missing authorized
        // files; do not overwrite the earlier turn's snapshot if repository files changed.
        const ownDir = join(resolveDataDir(this.options.config), "tasks", task.id);
        const ownManifest = join(ownDir, "context-manifest.json");
        let hasManifest = true;
        try { await stat(ownManifest); } catch { hasManifest = false; }
        if (!hasManifest) {
          const missing: string[] = [];
          for (const file of task.context_files) {
            try { await stat(join(task.context_path, file)); }
            catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
              missing.push(file);
            }
          }
          if (missing.length) await writeContextSnapshot({ repoRoot: task.repo_root, files: missing, destination: task.context_path, exclusive: true });
          const files = await inspectContextFiles(task.context_path, task.context_files);
          await mkdir(ownDir, { recursive: true, mode: 0o700 });
          await writeFile(ownManifest, JSON.stringify({ created_at: this.now().toISOString(), repo_root: task.repo_root, workspace: task.context_path, files, total_bytes: files.reduce((sum, file) => sum + file.bytes, 0) }, null, 2), { flag: "wx", mode: 0o600 });
          this.append(task, "bridge", "context.snapshot.extended", { workspace: task.context_path, manifest_path: ownManifest, files });
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

  private async scopeViolation(task: TaskRecord): Promise<string[] | null> {
    if (
      task.read_only ||
      task.write_paths.length === 0 ||
      task.worktree_path === null ||
      task.base_commit === null ||
      this.options.diffs === undefined
    ) {
      return null;
    }
    const diff = await this.options.diffs.getDiff({
      worktreePath: task.worktree_path,
      baseCommit: task.base_commit,
      maxChars: 1,
    });
    if (!diff.available) {
      throw new BridgeError(
        "SCOPE_VIOLATION",
        "Cannot verify write_paths because the task worktree is unavailable",
        { details: { task_id: task.id, worktree_path: task.worktree_path } },
      );
    }
    const changed = [
      ...new Set(diff.files.map((file) => file.path)),
    ];
    const contract: PathContract = {
      read_paths: task.read_paths,
      write_paths: task.write_paths,
      per_file_scope: true,
    };
    const violations = scopeViolations(changed, contract);
    return violations.length === 0 ? null : violations;
  }

  private async captureDeliverySnapshot(
    task: TaskRecord,
    usage: TaskUsage,
    sessionUsage: TaskUsage | null,
  ): Promise<void> {
    const worktreePath = task.worktree_path ?? task.workspace_path;
    if (
      worktreePath === null ||
      task.base_commit === null ||
      this.options.diffs === undefined
    ) {
      return;
    }
    try {
      const diff = await this.options.diffs.getDiff({
        worktreePath,
        baseCommit: task.base_commit,
        maxChars: SNAPSHOT_MAX_PATCH_CHARS,
      });
      if (!diff.available) return;
      const snapshot: DeliverySnapshot = {
        version: 1,
        task_id: task.id,
        captured_at: this.now().toISOString(),
        diff,
        usage: { ...usage },
        session_usage: sessionUsage === null ? null : { ...sessionUsage },
      };
      const written = await writeDeliverySnapshot(
        resolveDataDir(this.options.config),
        snapshot,
      );
      if (written) {
        this.append(task, "bridge", "delivery.snapshot.created", {
          worktree_path: worktreePath,
          base_commit: task.base_commit,
          patch_sha256: diff.full_patch_sha256,
          patch_bytes: diff.full_patch_bytes,
          files: diff.complete_file_count,
          omitted_files: diff.omitted_files,
        });
      }
    } catch (error) {
      this.options.logger.warn(
        { task_id: task.id, error: toErrorPayload(error) },
        "delivery snapshot capture failed",
      );
    }
  }

  private finishRun(task: TaskRecord, handle: RunHandle, result: AdapterRunResult): void {
    const usage = bestUsage(result.usage, task.usage);

    if (handle.stopReason === "budget" || this.budgetExceeded(usage)) {
      if (handle.stopReason !== "budget") {
        this.append(task, "system", "task.budget_exceeded", {
          usage,
          max_tokens: this.options.config.models.max_tokens,
          max_cost_usd: this.options.config.models.max_cost_usd,
          enforcement: "soft",
          execution_completed: handle.executionSucceeded,
        });
      }
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
    this.budgetThresholds.delete(task.id);
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
    // EventStore preserves redacted conversation/tool content in full.
    this.append(
      task,
      event.source,
      event.event_type,
      event.payload,
      event.event_type === "opencode.message"
        ? { maxPayloadChars: this.options.config.history.max_delegation_chars }
        : undefined,
    );

    const handle = this.running.get(task.id);
    if (handle !== undefined) {
      const finish =
        typeof event.payload.finish === "string"
          ? event.payload.finish
          : typeof event.payload.rawFinish === "string"
            ? event.payload.rawFinish
            : null;
      if (
        event.event_type === "opencode.execution.succeeded" ||
        event.event_type === "session.idle" ||
        (event.event_type === "opencode.step.ended" && finish === "stop")
      ) {
        handle.executionSucceeded = true;
      }
    }

    if (event.event_type === "usage.updated") {
      const usage = parseUsage(event.payload.usage);
      if (usage !== null) {
        task.usage = bestUsage(usage, task.usage);
        this.store?.saveUsage(task);
        this.checkBudgetThresholds(task, task.usage);
        if (
          this.budgetExceeded(task.usage) &&
          handle !== undefined &&
          handle.stopReason === null &&
          !handle.executionSucceeded
        ) {
          void this.requestStop(task, handle, "budget").catch((error: unknown) => {
            this.options.logger.error(
              { task_id: task.id, error: toErrorPayload(error) },
              "budget stop request failed",
            );
          });
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
      workspace_path: task.workspace_path,
      read_paths: [...task.read_paths],
      write_paths: [...task.write_paths],
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

  private checkBudgetThresholds(task: TaskRecord, usage: TaskUsage): void {
    const maxTokens = this.options.config.models.max_tokens;
    const maxCost = this.options.config.models.max_cost_usd;
    const tokenRatio =
      maxTokens === null || maxTokens <= 0 ? null : usage.total_tokens / maxTokens;
    const costRatio =
      maxCost === null || maxCost <= 0 || !usage.cost_known || usage.cost_usd === null
        ? null
        : usage.cost_usd / maxCost;
    const ratio = Math.max(tokenRatio ?? 0, costRatio ?? 0);
    const threshold = ratio >= 0.9 ? 90 : ratio >= 0.7 ? 70 : null;
    if (threshold === null) return;
    const previous = this.budgetThresholds.get(task.id) ?? 0;
    if (threshold <= previous) return;
    this.budgetThresholds.set(task.id, threshold);
    this.append(task, "system", "task.budget.threshold", {
      threshold_percent: threshold,
      consumed_tokens: usage.total_tokens,
      max_tokens: maxTokens,
      remaining_tokens:
        maxTokens === null ? null : Math.max(0, maxTokens - usage.total_tokens),
      consumed_cost_usd: usage.cost_usd,
      max_cost_usd: maxCost,
      remaining_cost_usd:
        maxCost === null || usage.cost_usd === null
          ? null
          : Math.max(0, maxCost - usage.cost_usd),
      enforcement: "soft",
    });
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
          read_paths: input.read_paths ?? [],
          write_paths: input.write_paths ?? [],
          workspace_from_task_id: input.workspace_from_task_id ?? null,
        }),
      )
      .digest("hex");
  }
}

function isWithinPath(root: string, candidate: string): boolean {
  const normalizedRoot = resolve(root);
  const normalizedCandidate = resolve(candidate);
  return (
    normalizedCandidate === normalizedRoot ||
    normalizedCandidate.startsWith(`${normalizedRoot}${sep}`)
  );
}

function truncatePatch(
  patch: string,
  maxChars: number,
): { patch: string; truncated: boolean } {
  if (patch.length <= maxChars) return { patch, truncated: false };
  return {
    patch: `${patch.slice(0, maxChars)}\n...[diff truncated at ${maxChars} characters]`,
    truncated: true,
  };
}

function combineTruncation(
  displayTruncated: boolean,
  source: "max_chars" | "untracked_limit" | "both" | "full_patch_limit" | null,
): "max_chars" | "untracked_limit" | "both" | "full_patch_limit" | null {
  if (displayTruncated && source !== null && source !== "max_chars") return "both";
  if (displayTruncated) return "max_chars";
  return source;
}

function unavailableTaskDiff(
  task: TaskRecord,
  reason: "no_worktree" | "workspace_removed",
): TaskDiffResult {
  return {
    task_id: task.id,
    reason,
    available: false,
    worktree_path: task.worktree_path ?? task.workspace_path,
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
    full_patch_sha256: null,
    full_patch_bytes: 0,
    complete_file_count: 0,
    returned_file_count: 0,
    omitted_files: [],
    full_patch_complete: false,
    truncation_reason: null,
  };
}

function latestSessionUsage(events: BridgeEvent[]): TaskUsage | null {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index];
    if (event === undefined || event.event_type !== "usage.updated") continue;
    const usage = parseUsage(event.payload.session_usage);
    if (usage !== null) return usage;
  }
  return null;
}

function bestUsage(
  primary: TaskUsage | undefined,
  fallback: TaskUsage,
): TaskUsage {
  if (primary === undefined) return fallback;
  if (primary.total_tokens !== fallback.total_tokens) {
    return primary.total_tokens > fallback.total_tokens ? primary : fallback;
  }
  if (primary.model_calls !== fallback.model_calls) {
    return primary.model_calls > fallback.model_calls ? primary : fallback;
  }
  if (!primary.cost_known && fallback.cost_known) return fallback;
  return primary;
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
  dataDir: string,
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
  let manifestPath = join(dataDir, "tasks", task.id, "context-manifest.json");
  try { await stat(manifestPath); } catch { manifestPath = join(dirname(task.context_path), "context-manifest.json"); }
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

function limitField(
  record: Record<string, unknown> | null,
  key: string,
): { found: boolean; value: number | null } {
  if (record === null || !(key in record)) return { found: false, value: null };
  const value = record[key];
  return {
    found: true,
    value: typeof value === "number" && Number.isFinite(value) ? value : null,
  };
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
