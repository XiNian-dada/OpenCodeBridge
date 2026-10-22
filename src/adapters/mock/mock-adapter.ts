import { randomUUID } from "node:crypto";
import type { MockScenario } from "../../config.js";
import { BridgeError, isBridgeError } from "../../errors.js";
import type { TaskRecord, TaskUsage } from "../../types.js";
import { emptyUsage } from "../../types.js";
import type {
  AbortResult,
  AdapterContext,
  AdapterProbe,
  AdapterRunResult,
  AdapterSession,
  AgentAdapter,
} from "../adapter.js";

export interface MockAdapterOptions {
  scenario?: MockScenario;
  delayMs?: number;
}

function mockUsage(): TaskUsage {
  return {
    ...emptyUsage(),
    input_tokens: 120,
    output_tokens: 80,
    total_tokens: 200,
    model_calls: 1,
    cost_usd: 0,
    cost_known: true,
  };
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new BridgeError("TASK_ABORTED", "Mock task was aborted"));
      return;
    }

    let timer: NodeJS.Timeout;
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const onAbort = () => {
      clearTimeout(timer);
      cleanup();
      reject(new BridgeError("TASK_ABORTED", "Mock task was aborted"));
    };
    timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export class MockAdapter implements AgentAdapter {
  readonly name = "mock";
  readonly supportsWrites = true;
  readonly requiresIsolatedWorktree = false;
  private readonly scenario: MockScenario;
  private readonly delayMs: number;
  private readonly aborted = new Set<string>();

  constructor(options: MockAdapterOptions = {}) {
    this.scenario = options.scenario ?? "success";
    this.delayMs = options.delayMs ?? 20;
  }

  async probe(): Promise<AdapterProbe> {
    return {
      name: "mock",
      version: "0.1.0",
      compatible: true,
      details: { scenario: this.scenario },
    };
  }

  buildPrompt(task: TaskRecord): string {
    return task.task;
  }

  async start(
    _task: TaskRecord,
    prompt: string,
    context: AdapterContext,
  ): Promise<AdapterRunResult> {
    const session: AdapterSession = {
      id: `mock_sess_${randomUUID()}`,
      model: _task.model,
      provider_id: _task.provider_id,
      worktree_path: null,
    };

    context.onSession(session);
    context.emit({
      source: "opencode",
      event_type: "opencode.prompt.received",
      payload: { prompt, model: _task.model },
    });
    context.emit({
      source: "opencode",
      event_type: "opencode.message",
      payload: {
        role: "assistant",
        text: "Mock agent received the delegated task.",
      },
    });

    try {
      await abortableDelay(this.scenario === "slow" ? 60_000 : this.delayMs, context.signal);

      if (this.aborted.has(session.id) || context.signal.aborted) {
        return {
          summary: "Mock task aborted before completion",
          usage: mockUsage(),
          stopped: true,
        };
      }

      if (this.scenario === "fail") {
        context.emit({
          source: "opencode",
          event_type: "opencode.message",
          payload: { role: "assistant", text: "Mock agent failed intentionally." },
        });
        throw new BridgeError("ADAPTER_ERROR", "Mock adapter failed intentionally", {
          retryable: true,
          details: { scenario: "fail" },
        });
      }

      context.emit({
        source: "tool",
        event_type: "tool.called",
        payload: {
          tool: "bash",
          call_id: "mock-call-1",
          input: { command: "pnpm test" },
          note: "mock event, not a real command execution",
        },
      });
      context.emit({
        source: "tool",
        event_type: "tool.completed",
        payload: {
          tool: "bash",
          call_id: "mock-call-1",
          status: "passed",
          output: "mock tests passed (not a real test run)",
        },
      });
      context.emit({
        source: "opencode",
        event_type: "usage.updated",
        payload: { usage: mockUsage() },
      });
      context.emit({
        source: "opencode",
        event_type: "opencode.message",
        payload: {
          role: "assistant",
          text: "Mock agent completed the delegated task.",
        },
      });

      return {
        summary: "Mock task completed successfully",
        usage: mockUsage(),
        tests: { status: "passed", source: "mock" },
      };
    } catch (error) {
      if (isBridgeError(error) && error.code === "TASK_ABORTED") {
        return {
          summary: "Mock task aborted",
          usage: mockUsage(),
          stopped: true,
        };
      }
      throw error;
    }
  }

  async abort(session: AdapterSession): Promise<AbortResult> {
    this.aborted.add(session.id);
    return { stopped: true, detail: "mock session stopped" };
  }

  async shutdown(): Promise<void> {
    this.aborted.clear();
  }
}
