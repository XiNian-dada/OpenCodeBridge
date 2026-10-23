import { randomUUID } from "node:crypto";
import { connect, type Socket } from "node:net";
import type { BridgeConfig } from "../config.js";
import { BridgeError, isBridgeError, type ErrorPayload } from "../errors.js";
import type {
  AbortTaskResult,
  HistoryQuery,
  SpawnResult,
  SpawnTaskInput,
  TaskListFilter,
  TaskView,
  CleanupOptions,
  CleanupResult,
  BridgeCapabilities,
  WaitTasksInput,
  WaitTasksResult,
} from "../types.js";
import type { TaskDiffResult, TaskHistoryResult, TaskService } from "../core/task-service.js";
import type { IpcResponse } from "./protocol.js";

interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

export class IpcTaskClient implements TaskService {
  private readonly pending = new Map<string, Pending>();
  private buffer = "";
  private closed = false;

  private constructor(
    private readonly socket: Socket,
    readonly socketPath: string,
  ) {
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => this.onData(chunk));
    socket.on("close", () => this.failPending("Bridge daemon connection closed"));
    socket.on("error", (error) => this.failPending(`Bridge daemon connection error: ${error.message}`));
  }

  static connect(socketPath: string, timeoutMs = 5000): Promise<IpcTaskClient> {
    return new Promise((resolve, reject) => {
      const socket = connect(socketPath);
      const timer = setTimeout(() => {
        socket.destroy();
        reject(
          new BridgeError("DAEMON_UNAVAILABLE", `Timed out connecting to bridge daemon at ${socketPath}`),
        );
      }, timeoutMs);

      socket.once("connect", () => {
        clearTimeout(timer);
        resolve(new IpcTaskClient(socket, socketPath));
      });
      socket.once("error", (error) => {
        clearTimeout(timer);
        reject(
          new BridgeError("DAEMON_UNAVAILABLE", `Cannot connect to bridge daemon at ${socketPath}`, {
            cause: error,
          }),
        );
      });
    });
  }

  capabilities(): Promise<BridgeCapabilities> {
    return this.request("capabilities", {});
  }

  wait(input: WaitTasksInput): Promise<WaitTasksResult> {
    return this.request("wait", input);
  }

  spawn(input: SpawnTaskInput): Promise<SpawnResult> {
    return this.request("spawn", input);
  }

  status(taskId: string): Promise<TaskView> {
    return this.request("status", { task_id: taskId });
  }

  history(taskId: string, query: HistoryQuery): Promise<TaskHistoryResult> {
    return this.request("history", {
      task_id: taskId,
      limit: query.limit,
      ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
      ...(query.after === undefined ? {} : { after: query.after }),
      ...(query.types === undefined ? {} : { types: query.types }),
    });
  }

  message(taskId: string, message: string): Promise<SpawnResult> {
    return this.request("message", { task_id: taskId, message });
  }

  abort(taskId: string): Promise<AbortTaskResult> {
    return this.request("abort", { task_id: taskId }, 30_000);
  }

  diff(
    taskId: string,
    options: { file?: string; maxChars?: number } = {},
  ): Promise<TaskDiffResult> {
    return this.request("diff", {
      task_id: taskId,
      ...(options.file === undefined ? {} : { file: options.file }),
      ...(options.maxChars === undefined ? {} : { max_chars: options.maxChars }),
    });
  }

  list(filter: TaskListFilter): Promise<TaskView[]> {
    return this.request("list", filter);
  }

  cleanup(options: CleanupOptions): Promise<CleanupResult> {
    return this.request("cleanup", options);
  }

  approveCleanup(approvalId: string): Promise<CleanupResult> {
    return this.request("approve_cleanup", { approval_id: approvalId });
  }

  async shutdownDaemon(): Promise<void> {
    await this.request("shutdown", {});
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.socket.destroy();
    this.failPending("Bridge daemon client closed");
  }

  private request<T>(method: string, params: unknown, timeoutMs = 60_000): Promise<T> {
    if (this.closed) {
      return Promise.reject(new BridgeError("DAEMON_UNAVAILABLE", "Bridge daemon client is closed"));
    }
    const id = randomUUID();
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new BridgeError("DAEMON_UNAVAILABLE", `Bridge daemon request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });
      this.socket.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    while (true) {
      const newline = this.buffer.indexOf("\n");
      if (newline === -1) return;
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (line.trim() === "") continue;

      let response: IpcResponse;
      try {
        response = JSON.parse(line) as IpcResponse;
      } catch {
        this.failPending("Bridge daemon returned invalid JSON");
        return;
      }

      const pending = this.pending.get(response.id);
      if (pending === undefined) continue;
      this.pending.delete(response.id);
      clearTimeout(pending.timer);

      if (response.ok) {
        pending.resolve(response.result);
      } else {
        pending.reject(fromErrorPayload(response.error));
      }
    }
  }

  private failPending(message: string): void {
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      clearTimeout(pending.timer);
      pending.reject(new BridgeError("DAEMON_UNAVAILABLE", message));
    }
  }
}

function fromErrorPayload(error: ErrorPayload): BridgeError {
  return new BridgeError(error.code, error.message, {
    retryable: error.retryable,
    ...(error.details === undefined ? {} : { details: error.details }),
  });
}

export async function connectToDaemon(socketPath: string): Promise<IpcTaskClient> {
  try {
    return await IpcTaskClient.connect(socketPath);
  } catch (error) {
    if (isBridgeError(error)) throw error;
    throw new BridgeError("DAEMON_UNAVAILABLE", "Cannot connect to bridge daemon", { cause: error });
  }
}
