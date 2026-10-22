import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { BridgeConfig } from "../config.js";
import { BridgeError, isBridgeError } from "../errors.js";
import type { Logger } from "../logging.js";
import { resolveDataDir } from "../paths.js";
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
import { modelCostKnown, resolveOpenCodeModel } from "./model-resolver.js";
import {
  startManagedOpenCodeServer,
  versionMatches,
  type ManagedOpenCodeServer,
  type ManagedOpenCodeServerOptions,
} from "./process.js";
import type { OpenCodeMessage, OpenCodeSession } from "./types.js";

const execFileAsync = promisify(execFile);

const READ_ONLY_PERMISSIONS = [
  { action: "*", resource: "*", effect: "deny" },
  { action: "read", resource: "*", effect: "allow" },
  { action: "glob", resource: "*", effect: "allow" },
  { action: "grep", resource: "*", effect: "allow" },
  { action: "read", resource: "*.env", effect: "deny" },
  { action: "read", resource: "*.env.*", effect: "deny" },
] as const;

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

export class OpenCodeAdapter implements AgentAdapter {
  readonly name = "opencode";
  readonly supportsWrites = false;
  readonly requiresIsolatedWorktree = true;
  private readonly active = new Map<string, ActiveRun>();
  private readonly serverStarter: (options: ManagedOpenCodeServerOptions) => Promise<ManagedOpenCodeServer>;

  constructor(private readonly options: OpenCodeAdapterOptions) {
    this.serverStarter = options.serverStarter ?? startManagedOpenCodeServer;
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
      `Workspace: ${task.worktree_path ?? task.repo_root}`,
      "Mode: READ-ONLY. Do not modify files. Do not run commands that modify files.",
      "Do not access paths outside the workspace, use network tools, launch subagents, or change configuration.",
      "If the task cannot be completed within these constraints, report the blocker instead of expanding scope.",
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
    if (!task.read_only) {
      throw new BridgeError(
        "SANDBOX_UNAVAILABLE",
        "The OpenCode adapter is read-only until Phase 3 worktree and sandbox support",
        { details: { task_id: task.id } },
      );
    }

    const dataDir = resolveDataDir(this.options.config);
    let server: ManagedOpenCodeServer | null = null;
    let run: ActiveRun | null = null;

    try {
      server = await this.serverStarter({
        binary: this.options.config.opencode.binary,
        cwd: task.worktree_path ?? task.repo_root,
        dataDir,
        taskId: task.id,
        configContent: { permissions: [...READ_ONLY_PERMISSIONS] },
        compatibility: this.options.config.opencode.compatibility,
        startupTimeoutMs: this.options.config.opencode.startup_timeout_ms,
        logger: this.options.logger,
        signal: context.signal,
      });

      context.emit({
        source: "bridge",
        event_type: "opencode.server.started",
        payload: {
          pid: server.pid,
          port: server.port,
          version: server.info.version,
          log_path: server.logPath,
        },
      });
      ensureNotAborted(context.signal);

      const model = await resolveOpenCodeModel(server.client, task);
      context.emit({
        source: "bridge",
        event_type: "opencode.model.resolved",
        payload: {
          provider_id: model.providerID,
          model_id: model.modelID,
          advertised_id: model.id,
          cost_known: modelCostKnown(model),
        },
      });

      ensureNotAborted(context.signal);
      const variant = task.model_variant ?? undefined;
      const session = await server.client.createSession({
        title: `Bridge ${task.id}`,
        model: {
          providerID: task.provider_id,
          id: model.id,
          ...(variant === undefined ? {} : { variant }),
        },
      });

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
      };
      this.active.set(session.id, run);
      ensureNotAborted(context.signal);

      context.onSession({
        id: session.id,
        model: task.model,
        provider_id: task.provider_id,
        worktree_path: task.worktree_path,
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

    const usage = usageFromSession(session, messages);
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
      return usageFromSession(session, messages);
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
    return new BridgeError("BUDGET_EXCEEDED", message, { details: { upstream: message } });
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

function usageFromSession(session: OpenCodeSession, messages: OpenCodeMessage[]): TaskUsage {
  const tokens = session.tokens;
  const input = tokens?.input ?? 0;
  const output = tokens?.output ?? 0;
  const reasoning = tokens?.reasoning ?? 0;
  const cost = typeof session.cost === "number" ? session.cost : null;
  const calls = Math.max(
    messages.filter((message) => roleOf(message) === "assistant").length,
    input > 0 || output > 0 ? 1 : 0,
  );

  return {
    input_tokens: input,
    output_tokens: output,
    reasoning_tokens: reasoning,
    cache_read_tokens: tokens?.cache?.read ?? 0,
    cache_write_tokens: tokens?.cache?.write ?? 0,
    total_tokens: input + output + reasoning,
    model_calls: calls,
    cost_usd: cost,
    cost_known: cost !== null,
  };
}

export { READ_ONLY_PERMISSIONS };
