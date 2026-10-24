import { execFile } from "node:child_process";
import { rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { BridgeConfig } from "../config.js";
import { BridgeError, isBridgeError } from "../errors.js";
import type { Logger } from "../logging.js";
import { resolveDataDir } from "../paths.js";
import { sandboxAvailable } from "../security/sandbox.js";
import type { TaskRecord, TaskUsage } from "../types.js";
import { emptyUsage } from "../types.js";
import type {
  AbortResult,
  AdapterContext,
  AdapterProbe,
  AdapterRunResult,
  AdapterSession,
  AgentAdapter,
} from "../adapters/adapter.js";
import {
  eventErrorMessage,
  isErrorEvent,
  isEventForSession,
  isIdleEvent,
  mapOpenCodeEvent,
} from "./events.js";
import { OpenCodeHttpClient, OpenCodeHttpError } from "./http-client.js";
import {
  findOpenCodeModel,
  gatewaySettingsFor,
  modelCostKnown,
  resolveOpenCodeModel,
} from "./model-resolver.js";
import { consoleCredential } from "./console-credential.js";
import { startModelGateway, type ModelGateway } from "./model-gateway.js";
import {
  startManagedOpenCodeServer,
  versionMatches,
  type ManagedOpenCodeServer,
  type ManagedOpenCodeServerOptions,
} from "./process.js";
import type { OpenCodeMessage, OpenCodeModel, OpenCodeModelCost, OpenCodeSession } from "./types.js";

const execFileAsync = promisify(execFile);

const READ_ONLY_PERMISSIONS = [
  { action: "*", resource: "*", effect: "deny" },
  { action: "read", resource: "*", effect: "allow" },
  { action: "glob", resource: "*", effect: "allow" },
  { action: "grep", resource: "*", effect: "allow" },
  { action: "read", resource: "*.env", effect: "deny" },
  { action: "read", resource: "*.env.*", effect: "deny" },
] as const;

const WRITABLE_PERMISSIONS = [
  { action: "*", resource: "*", effect: "deny" },
  { action: "read", resource: "*", effect: "allow" },
  { action: "glob", resource: "*", effect: "allow" },
  { action: "grep", resource: "*", effect: "allow" },
  { action: "edit", resource: "*", effect: "allow" },
  { action: "read", resource: "*.env", effect: "deny" },
  { action: "read", resource: "*.env.*", effect: "deny" },
] as const;

function protectedOpenCodePaths(): string[] {
  const dataHome = process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share");
  const stateHome = process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state");
  const cacheHome = process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache");
  const configHome = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  return [
    join(dataHome, "opencode"),
    join(stateHome, "opencode"),
    join(cacheHome, "opencode"),
    join(configHome, "opencode"),
  ];
}

function permissionsFor(readOnly: boolean): Array<{
  action: string;
  resource: string;
  effect: "allow" | "deny";
}> {
  const base = readOnly ? READ_ONLY_PERMISSIONS : WRITABLE_PERMISSIONS;
  const protectedRules = protectedOpenCodePaths().flatMap((path) =>
    [path, `${path}/*`, `${path}/**`].flatMap((resource) =>
      ["read", "glob", "grep"].map((action) => ({
        action,
        resource,
        effect: "deny" as const,
      })),
    ),
  );
  return [...base, ...protectedRules];
}

type CompletionReason = "idle" | "error" | "aborted";

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

interface ActiveRun {
  sessionId: string;
  client: OpenCodeHttpClient;
  server: ManagedOpenCodeServer;
  completion: Deferred<CompletionReason>;
  eventsAbort: AbortController;
  pollAbort: AbortController;
  finished: boolean;
  abortRequested: boolean;
  errorMessage: string | null;
  gateway: boolean;
  modelCost: OpenCodeModelCost[] | null;
}

export interface OpenCodeAdapterOptions {
  config: BridgeConfig;
  logger: Logger;
  serverStarter?: (options: ManagedOpenCodeServerOptions) => Promise<ManagedOpenCodeServer>;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

interface PreparedBackend {
  gateway: ModelGateway | null;
  model: OpenCodeModel | null;
  configContent: Record<string, unknown>;
  homeDir: string | null;
  sandbox: ManagedOpenCodeServerOptions["sandbox"];
}

export class OpenCodeAdapter implements AgentAdapter {
  readonly name = "opencode";
  readonly supportsWrites = sandboxAvailable();
  readonly supportsReadIsolation: boolean;
  readonly requiresIsolatedWorktree = true;
  private readonly active = new Map<string, ActiveRun>();
  private readonly serverStarter: (options: ManagedOpenCodeServerOptions) => Promise<ManagedOpenCodeServer>;
  private readonly canProbeGateway: boolean;

  constructor(private readonly options: OpenCodeAdapterOptions) {
    this.supportsReadIsolation =
      options.config.security.read_sandbox !== "off" && sandboxAvailable();
    this.serverStarter = options.serverStarter ?? startManagedOpenCodeServer;
    this.canProbeGateway = options.serverStarter === undefined;
  }

  async probe(): Promise<AdapterProbe> {
    let output: string;
    try {
      const result = await execFileAsync(this.options.config.opencode.binary, ["--version"], {
        timeout: 5000,
      });
      output = result.stdout.trim();
    } catch (error) {
      throw new BridgeError("OPENCODE_UNAVAILABLE", "OpenCode executable is not available", {
        cause: error,
        details: { binary: this.options.config.opencode.binary },
      });
    }

    const match = /(\d+\.\d+\.\d+)/.exec(output);
    const version = match?.[1] ?? output;
    return {
      name: "opencode",
      version,
      compatible: match !== null && versionMatches(version, this.options.config.opencode.compatibility),
      details: { binary: this.options.config.opencode.binary },
    };
  }

  buildPrompt(task: TaskRecord): string {
    return [
      "You are executing a delegated task under bridge-enforced constraints.",
      `Task ID: ${task.id}`,
      `Task type: ${task.task_type}`,
      `Workspace: ${task.context_path ?? task.worktree_path ?? task.repo_root}`,
      task.read_only
        ? "Mode: READ-ONLY. Do not modify files. Do not run commands that modify files."
        : "Mode: WRITABLE (edit-only). Modify files only inside this workspace; never run shell commands.",
      "Do not access paths outside the workspace, use network tools, launch subagents, or change configuration.",
      "If the task cannot be completed within these constraints, report the blocker instead of expanding scope.",
      "For review or analysis findings, report every issue with:",
      "Location: path:line",
      "Trigger: the exact condition that exposes the problem",
      "Evidence: the observed code, output, or reproduction",
      "Confidence: reproduced | static-inference | needs-confirmation",
      "Only use 'reproduced' for something you actually observed. Shell is unavailable; if tests were not run, say 'not run' instead of claiming they passed.",
      ...(task.task_type === "review" || task.task_type === "analysis"
        ? [
            "End the reply with a fenced ```json block in this exact shape:",
            '{"findings":[{"location":"path:line","trigger":"...","evidence":"...","confidence":"reproduced|static-inference|needs-confirmation"}]}',
            "Use an empty findings array when there are no findings. Do not put prose after the JSON block.",
          ]
        : []),
      "",
      "TASK:",
      task.task,
    ].join("\n");
  }

  async start(
    task: TaskRecord,
    prompt: string,
    context: AdapterContext,
  ): Promise<AdapterRunResult> {
    if (!task.read_only && !this.supportsWrites) {
      throw new BridgeError(
        "SANDBOX_UNAVAILABLE",
        "Writable OpenCode tasks require an available OS sandbox",
        { details: { task_id: task.id, platform: process.platform } },
      );
    }
    if (
      task.read_only &&
      this.options.config.security.read_sandbox === "require" &&
      !this.supportsReadIsolation
    ) {
      throw new BridgeError(
        "SANDBOX_UNAVAILABLE",
        "Read-only OpenCode tasks require an OS read sandbox on this host",
        { details: { task_id: task.id, platform: process.platform } },
      );
    }
    if (!task.read_only && task.worktree_path === null) {
      throw new BridgeError(
        "WORKTREE_CREATE_FAILED",
        "Writable OpenCode task has no isolated worktree",
        { details: { task_id: task.id } },
      );
    }
    if (!task.read_only && task.worktree_git_dir === null) {
      throw new BridgeError(
        "WORKTREE_CREATE_FAILED",
        "Writable OpenCode task has no worktree Git metadata path",
        { details: { task_id: task.id } },
      );
    }

    const dataDir = resolveDataDir(this.options.config);
    const permissions = permissionsFor(task.read_only);
    const workspace = task.context_path ?? task.worktree_path ?? task.repo_root;
    let backend = await this.prepareBackend(task, workspace, dataDir, permissions, context);
    let server: ManagedOpenCodeServer | null = null;
    let run: ActiveRun | null = null;

    try {
      server = await this.serverStarter({
        binary: this.options.config.opencode.binary,
        cwd: workspace,
        dataDir,
        taskId: task.opencode_task_id,
        configContent: backend.configContent,
        compatibility: this.options.config.opencode.compatibility,
        startupTimeoutMs: this.options.config.opencode.startup_timeout_ms,
        logger: this.options.logger,
        signal: context.signal,
        ...(backend.homeDir === null ? {} : { homeDir: backend.homeDir }),
        ...(backend.sandbox === undefined ? {} : { sandbox: backend.sandbox }),
      });

      context.emit({
        source: "bridge",
        event_type: "opencode.server.started",
        payload: {
          pid: server.pid,
          port: server.port,
          version: server.info.version,
          log_path: server.logPath,
          sandboxed: server.sandboxed,
          model_gateway: backend.gateway !== null,
        },
      });
      ensureNotAborted(context.signal);

      const model = backend.model ?? await resolveOpenCodeModel(server.client, task);
      backend = { ...backend, model };
      context.emit({
        source: "bridge",
        event_type: "opencode.model.resolved",
        payload: {
          provider_id: task.provider_id,
          model_id: task.model_id,
          advertised_id: model.id,
          cost_known: modelCostKnown(model),
          gateway: backend.gateway !== null,
        },
      });

      ensureNotAborted(context.signal);
      const variant = task.model_variant ?? undefined;
      let session: OpenCodeSession;
      if (task.session_id !== null) {
        try {
          session = await server.client.session(task.session_id);
        } catch (error) {
          throw new BridgeError("SESSION_LOST", "OpenCode session could not be resumed", {
            cause: error,
            details: { task_id: task.id, session_id: task.session_id },
          });
        }
        context.emit({
          source: "opencode",
          event_type: "opencode.session.resumed",
          payload: { session_id: session.id, turn: task.turn },
        });
      } else {
        session = await server.client.createSession({
          title: `Bridge ${task.id}`,
          model: {
            providerID: backend.gateway === null ? task.provider_id : "bridge-gateway",
            id: backend.gateway === null ? model.id : model.modelID,
            ...(variant === undefined ? {} : { variant }),
          },
        });
      }

      run = {
        sessionId: session.id,
        client: server.client,
        server,
        completion: deferred<CompletionReason>(),
        eventsAbort: new AbortController(),
        pollAbort: new AbortController(),
        finished: false,
        abortRequested: false,
        errorMessage: null,
        gateway: backend.gateway !== null,
        modelCost: Array.isArray(model.cost) ? model.cost : null,
      };
      this.active.set(session.id, run);
      ensureNotAborted(context.signal);

      context.onSession({
        id: session.id,
        model: task.model,
        provider_id: task.provider_id,
        worktree_path: task.worktree_path,
        server_pid: server.pid,
      });

      const eventsPromise = this.consumeEvents(run, context);
      const pollPromise = this.pollUntilIdle(run);
      const abortPromise = this.abortSignal(context.signal);

      try {
        ensureNotAborted(context.signal);
        await run.client.prompt(session.id, { text: prompt });
        context.emit({
          source: "opencode",
          event_type: "opencode.prompt.admitted",
          payload: { session_id: session.id },
        });

        const reason = await Promise.race([
          run.completion.promise,
          abortPromise,
          pollPromise,
        ]);

        if (reason === "aborted" || run.abortRequested) {
          return {
            summary: "OpenCode task was aborted",
            usage: await this.readUsage(run, false),
            stopped: true,
          };
        }

        if (reason === "error") {
          throw failureFromMessage(run.errorMessage ?? "OpenCode session failed");
        }

        const finalSession = await this.readFinalSession(run, context);
        if (finalSession.session?.outcome === "failed") {
          throw new BridgeError("ADAPTER_ERROR", "OpenCode reported a failed session");
        }
        if (finalSession.session?.outcome === "interrupted") {
          return {
            summary: "OpenCode session was interrupted",
            usage: finalSession.usage,
            stopped: true,
          };
        }

        const summary = finalSession.summary ?? "OpenCode session completed";
        context.emit({
          source: "opencode",
          event_type: "usage.updated",
          payload: { usage: finalSession.usage },
        });
        return {
          summary,
          usage: finalSession.usage,
        };
      } finally {
        run.finished = true;
        run.eventsAbort.abort();
        run.pollAbort.abort();
        this.active.delete(session.id);
        await Promise.allSettled([eventsPromise, pollPromise]);
      }
    } catch (error) {
      if (context.signal.aborted) {
        throw new BridgeError("TASK_ABORTED", "OpenCode task was aborted during startup");
      }
      if (isBridgeError(error)) throw error;
      throw failureFromError(error);
    } finally {
      if (server !== null) {
        try {
          await server.stop();
        } catch (error) {
          context.emit({
            source: "bridge",
            event_type: "opencode.server.stop_failed",
            payload: { message: error instanceof Error ? error.message : String(error) },
          });
        }
        context.emit({
          source: "bridge",
          event_type: "opencode.server.stopped",
          payload: { pid: server.pid, log_path: server.logPath },
        });
      }
      if (backend.gateway !== null) {
        try {
          await backend.gateway.stop();
          context.emit({
            source: "bridge",
            event_type: "opencode.model_gateway.stopped",
            payload: { upstream: backend.gateway.upstream },
          });
        } catch (error) {
          this.options.logger.warn(
            { error: error instanceof Error ? error.message : String(error) },
            "model gateway stop failed",
          );
        }
      }
    }
  }

  async abort(session: AdapterSession): Promise<AbortResult> {
    const run = this.active.get(session.id);
    if (run === undefined) {
      return { stopped: true, detail: "session is not active" };
    }

    run.abortRequested = true;
    let stopped = false;

    try {
      stopped = await run.client.interrupt(run.sessionId);
    } catch (error) {
      this.options.logger.warn(
        { task_id: run.sessionId, error: error instanceof Error ? error.message : String(error) },
        "OpenCode interrupt failed",
      );
    }

    if (!stopped) {
      try {
        const active = await run.client.activeSessions();
        stopped = !(run.sessionId in active);
      } catch {
        stopped = false;
      }
    }

    if (!stopped) {
      await run.server.stop();
      stopped = true;
    }

    run.completion.resolve("aborted");
    return {
      stopped,
      detail: stopped ? "OpenCode session stopped" : "OpenCode stop was not confirmed",
    };
  }

  async shutdown(): Promise<void> {
    const runs = [...this.active.values()];
    await Promise.allSettled(
      runs.map(async (run) => {
        run.abortRequested = true;
        try {
          await run.client.interrupt(run.sessionId);
        } catch {
          // Best effort; the server stop below is authoritative.
        }
        await run.server.stop();
        run.completion.resolve("aborted");
      }),
    );
    this.active.clear();
  }

  private async prepareBackend(
    task: TaskRecord,
    workspace: string,
    dataDir: string,
    permissions: ReturnType<typeof permissionsFor>,
    context: AdapterContext,
  ): Promise<PreparedBackend> {
    const directSandbox: ManagedOpenCodeServerOptions["sandbox"] = task.read_only
      ? this.supportsReadIsolation
        ? { mode: "read", worktreePath: workspace }
        : undefined
      : {
          mode: "write",
          worktreePath: task.worktree_path as string,
          gitDir: task.worktree_git_dir as string,
        };
    const direct: PreparedBackend = {
      gateway: null,
      model: null,
      configContent: { permissions, snapshots: false },
      homeDir: null,
      sandbox: directSandbox,
    };

    const mode = this.options.config.security.model_gateway;
    if (mode === "off" || !this.canProbeGateway) return direct;

    try {
      const probeId = `${task.id}-probe`;
      const probe = await this.serverStarter({
        binary: this.options.config.opencode.binary,
        cwd: workspace,
        dataDir,
        taskId: probeId,
        useUserDatabaseForDiscovery: true,
        configContent: {
          ...(task.provider_id === "opencode-go" && this.options.config.opencode.go_api_key ? {
            provider: { "opencode-go": { options: { apiKey: "bridge-discovery-placeholder" } } },
          } : {}),
          permissions: [{ action: "*", resource: "*", effect: "deny" }],
          mcp: {},
          plugin: [],
          plugins: [],
          snapshots: false,
        },
        compatibility: this.options.config.opencode.compatibility,
        startupTimeoutMs: this.options.config.opencode.startup_timeout_ms,
        logger: this.options.logger,
        signal: context.signal,
      });

      let model: OpenCodeModel | undefined;
      try {
        model = findOpenCodeModel(await probe.client.models(), task);
      } finally {
        await probe.stop();
        await rm(join(dataDir, "tasks", probeId), { recursive: true, force: true }).catch(() => undefined);
      }
      if (context.signal.aborted) {
        throw new BridgeError("TASK_ABORTED", "OpenCode task was aborted during model probe");
      }
      if (model === undefined) {
        throw new BridgeError(
          "MODEL_UNAVAILABLE",
          `OpenCode does not expose model ${task.provider_id}/${task.model_id}`,
        );
      }

      const settings = gatewaySettingsFor(model);
      if (!settings.supported || settings.baseURL === null) {
        if (mode === "require") {
          throw new BridgeError(
            "MODEL_GATEWAY_UNAVAILABLE",
            settings.reason ?? "This provider cannot be routed through the bridge model gateway",
          );
        }
        context.emit({
          source: "bridge",
          event_type: "opencode.model_gateway.unavailable",
          payload: { reason: settings.reason ?? "unsupported provider" },
        });
        return direct;
      }

      let apiKey = settings.apiKey;
      const headers: Record<string, string> = {};
      if (task.provider_id === "opencode-go") {
        const upstream = new URL(settings.baseURL);
        if (upstream.origin !== "https://opencode.ai" || !upstream.pathname.startsWith("/inference/go/")) {
          throw new BridgeError("MODEL_GATEWAY_UNAVAILABLE", "Unsupported Go credential destination");
        }
        const org = (model.headers as Record<string, unknown> | undefined)?.["x-opencode-org-id"];
        if (typeof org === "string") headers["x-opencode-org-id"] = org;
        apiKey = this.options.config.opencode.go_api_key || apiKey;
        if (!apiKey) {
          const credential = await consoleCredential(this.options.config.opencode.binary);
          if (!credential || (credential.expires !== null && credential.expires <= Date.now())) {
            throw new BridgeError("PROVIDER_AUTH_FAILED", "OpenCode Console login is unavailable or expired; reconnect in OpenCode or set a Go API key in Bridge settings");
          }
          if (org && credential.orgID && org !== credential.orgID) {
            throw new BridgeError("PROVIDER_AUTH_FAILED", "OpenCode Console workspace does not match the selected Go model");
          }
          apiKey = credential.token;
        }
      }
      const gateway = await startModelGateway({
        upstreamBaseUrl: settings.baseURL,
        apiKey,
        headers,
        logger: this.options.logger,
      });
      try {
        const homeDir = join(dataDir, "tasks", task.opencode_task_id, "home");
        const provider = {
          "bridge-gateway": {
            npm: "@ai-sdk/openai-compatible",
            name: "Bridge Gateway",
            options: {
              baseURL: gateway.url,
              apiKey: "bridge-local",
            },
            models: {
              [model.modelID]: { name: model.name ?? model.modelID },
            },
          },
        };
        const sandbox: ManagedOpenCodeServerOptions["sandbox"] = {
          mode: task.read_only ? "read" : "write",
          worktreePath: workspace,
          ...(task.worktree_git_dir === null ? {} : { gitDir: task.worktree_git_dir }),
          gatewayPort: gateway.port,
          isolateConfig: true,
        };

        context.emit({
          source: "bridge",
          event_type: "opencode.model_gateway.started",
          payload: {
            port: gateway.port,
            upstream: gateway.upstream,
            isolated_config: true,
          },
        });

        return {
          gateway,
          model,
          configContent: {
            permissions,
            snapshots: false,
            provider,
            mcp: {},
            plugin: [],
            plugins: [],
          },
          homeDir,
          sandbox,
        };
      } catch (error) {
        await gateway.stop();
        throw error;
      }
    } catch (error) {
      if (context.signal.aborted) {
        throw new BridgeError("TASK_ABORTED", "OpenCode task was aborted during model probe");
      }
      if (mode === "require") {
        if (isBridgeError(error)) throw error;
        throw new BridgeError(
          "MODEL_GATEWAY_UNAVAILABLE",
          "Bridge model gateway could not be prepared",
          { cause: error },
        );
      }
      context.emit({
        source: "bridge",
        event_type: "opencode.model_gateway.unavailable",
        payload: { message: error instanceof Error ? error.message : String(error) },
      });
      return direct;
    }
  }

  private async consumeEvents(run: ActiveRun, context: AdapterContext): Promise<void> {
    try {
      for await (const event of run.client.events(run.eventsAbort.signal)) {
        if (!isEventForSession(event, run.sessionId)) continue;

        const mapped = mapOpenCodeEvent(event);
        if (mapped !== null) context.emit(mapped);

        if (isErrorEvent(event)) {
          run.errorMessage = eventErrorMessage(event);
          run.completion.resolve("error");
          return;
        }
        if (isIdleEvent(event)) {
          run.completion.resolve("idle");
          return;
        }
      }
    } catch (error) {
      if (run.eventsAbort.signal.aborted) return;
      context.emit({
        source: "bridge",
        event_type: "opencode.event_stream.disconnected",
        payload: { message: error instanceof Error ? error.message : String(error) },
      });
    }
  }

  private async pollUntilIdle(run: ActiveRun): Promise<CompletionReason> {
    while (!run.finished && !run.pollAbort.signal.aborted) {
      await sleep(500, run.pollAbort.signal);
      if (run.finished || run.pollAbort.signal.aborted) break;

      try {
        const active = await run.client.activeSessions(run.pollAbort.signal);
        if (run.sessionId in active) continue;

        const messages = await run.client.messages(run.sessionId, 100, run.pollAbort.signal);
        if (messages.some((message) => roleOf(message) === "assistant")) return "idle";

        const session = await run.client.session(run.sessionId, run.pollAbort.signal);
        if (session.time?.idle !== undefined || session.outcome !== undefined) return "idle";
      } catch {
        if (run.pollAbort.signal.aborted) return "aborted";
      }
    }
    return "aborted";
  }

  private abortSignal(signal: AbortSignal): Promise<CompletionReason> {
    return new Promise((resolve) => {
      if (signal.aborted) {
        resolve("aborted");
        return;
      }
      signal.addEventListener("abort", () => resolve("aborted"), { once: true });
    });
  }

  private async readFinalSession(run: ActiveRun, context: AdapterContext): Promise<{
    session: OpenCodeSession | null;
    usage: TaskUsage;
    summary: string | null;
  }> {
    let session: OpenCodeSession | null = null;
    let messages: OpenCodeMessage[] = [];

    try {
      [session, messages] = await Promise.all([
        run.client.session(run.sessionId),
        run.client.messages(run.sessionId, 200),
      ]);
    } catch (error) {
      context.emit({
        source: "bridge",
        event_type: "opencode.result_read_failed",
        payload: { message: error instanceof Error ? error.message : String(error) },
      });
      return {
        session: null,
        usage: emptyUsage(),
        summary: `OpenCode completed, but result readback failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }

    // The live 2.1 API lists newest messages first; mocks/older APIs may not.
    // Sort chronologically before selecting the latest assistant answer.
    messages.sort((a, b) => messageCreatedAt(a) - messageCreatedAt(b));
    for (const message of messages.slice(-50)) {
      const role = roleOf(message);
      const text = textOf(message);
      if (role === null || text === null) continue;
      context.emit({
        source: "opencode",
        event_type: "opencode.message",
        payload: { role, text },
      });
    }

    const usage = usageFromSession(session, messages, run.modelCost, run.gateway);
    const assistantTexts = messages
      .filter((message) => roleOf(message) === "assistant")
      .map((message) => textOf(message))
      .filter((text): text is string => text !== null && text.trim() !== "");

    return {
      session,
      usage,
      summary: assistantTexts.at(-1) ?? null,
    };
  }

  private async readUsage(run: ActiveRun, includeMessages: boolean): Promise<TaskUsage> {
    try {
      const session = await run.client.session(run.sessionId);
      const messages = includeMessages ? await run.client.messages(run.sessionId, 200) : [];
      return usageFromSession(session, messages, run.modelCost, run.gateway);
    } catch {
      return emptyUsage();
    }
  }
}

function ensureNotAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new BridgeError("TASK_ABORTED", "OpenCode task was aborted");
  }
}

function failureFromError(error: unknown): BridgeError {
  if (error instanceof BridgeError) return error;
  if (error instanceof OpenCodeHttpError) {
    const body = error.body as { message?: unknown } | null;
    const message = typeof body?.message === "string" ? body.message : error.message;
    if (error.status === 401 || error.status === 403) {
      return new BridgeError("PROVIDER_AUTH_FAILED", message, {
        details: { status: error.status },
      });
    }
    if (error.status === 404) {
      return new BridgeError("SESSION_LOST", message, {
        details: { status: error.status },
      });
    }
    if (error.status >= 500 || error.status === 429) {
      return new BridgeError("ADAPTER_ERROR", message, {
        retryable: true,
        details: { status: error.status },
      });
    }
    return failureFromMessage(message);
  }
  return failureFromMessage(error instanceof Error ? error.message : String(error));
}

function failureFromMessage(message: string): BridgeError {
  if (/region|country|unsupported location/i.test(message)) {
    return new BridgeError("REGION_RESTRICTED", message, { details: { upstream: message } });
  }
  if (/balance|quota|billing|insufficient|credit/i.test(message)) {
    return new BridgeError("PROVIDER_QUOTA_EXCEEDED", message, { details: { upstream: message } });
  }
  if (/auth|api key|unauthorized|forbidden/i.test(message)) {
    return new BridgeError("PROVIDER_AUTH_FAILED", message, { details: { upstream: message } });
  }
  if (/model.*(not found|unavailable|does not exist)|no such model/i.test(message)) {
    return new BridgeError("MODEL_UNAVAILABLE", message, { details: { upstream: message } });
  }
  return new BridgeError("ADAPTER_ERROR", message, { details: { upstream: message } });
}

function roleOf(message: OpenCodeMessage): "user" | "assistant" | null {
  const direct = message.type;
  if (direct === "user" || direct === "assistant") return direct;

  const info = message.info;
  if (typeof info === "object" && info !== null) {
    const role = (info as Record<string, unknown>).role;
    if (role === "user" || role === "assistant") return role;
  }

  const payload = message.payload;
  if (typeof payload === "object" && payload !== null) {
    const role = (payload as Record<string, unknown>).role;
    if (role === "user" || role === "assistant") return role;
  }

  return null;
}

function messageCreatedAt(message: OpenCodeMessage): number {
  const time = message.time;
  if (typeof time === "object" && time !== null) {
    const created = (time as Record<string, unknown>).created;
    if (typeof created === "number" && Number.isFinite(created)) return created;
  }
  return 0;
}

function textOf(message: OpenCodeMessage): string | null {
  const direct = message.text;
  if (typeof direct === "string") return direct;

  const payload = message.payload;
  if (typeof payload === "object" && payload !== null) {
    const text = (payload as Record<string, unknown>).text;
    if (typeof text === "string") return text;
  }

  for (const collection of [message.content, message.parts]) {
    if (!Array.isArray(collection)) continue;
    const texts: string[] = [];
    for (const part of collection) {
      if (typeof part !== "object" || part === null) continue;
      const entry = part as Record<string, unknown>;
      if (entry.type === "text" && typeof entry.text === "string") texts.push(entry.text);
    }
    if (texts.length > 0) return texts.join("\n");
  }

  return null;
}

function usageFromSession(
  session: OpenCodeSession,
  messages: OpenCodeMessage[],
  modelCost: OpenCodeModelCost[] | null = null,
  gateway = false,
): TaskUsage {
  const tokens = session.tokens;
  const input = tokens?.input ?? 0;
  const output = tokens?.output ?? 0;
  const reasoning = tokens?.reasoning ?? 0;
  const cacheRead = tokens?.cache?.read ?? 0;
  const cacheWrite = tokens?.cache?.write ?? 0;
  const calls = Math.max(
    messages.filter((message) => roleOf(message) === "assistant").length,
    input > 0 || output > 0 ? 1 : 0,
  );
  const gatewayCost = gateway ? calculateCost(input, output, reasoning, cacheRead, cacheWrite, modelCost) : null;
  const sessionCost = typeof session.cost === "number" ? session.cost : null;

  return {
    input_tokens: input,
    output_tokens: output,
    reasoning_tokens: reasoning,
    cache_read_tokens: cacheRead,
    cache_write_tokens: cacheWrite,
    total_tokens: input + output + reasoning,
    model_calls: calls,
    cost_usd: gateway ? gatewayCost : sessionCost,
    cost_known: gateway ? gatewayCost !== null : sessionCost !== null,
  };
}

function calculateCost(
  input: number,
  output: number,
  reasoning: number,
  cacheRead: number,
  cacheWrite: number,
  modelCost: OpenCodeModelCost[] | null,
): number | null {
  if (modelCost === null || modelCost.length === 0) return null;
  const rate = modelCost.find((entry) => entry.tier === undefined) ?? modelCost[0];
  if (rate === undefined) return null;
  const cost =
    input * rate.input +
    (output + reasoning) * rate.output +
    cacheRead * (rate.cache?.read ?? 0) +
    cacheWrite * (rate.cache?.write ?? 0);
  return cost / 1_000_000;
}

export { READ_ONLY_PERMISSIONS };
