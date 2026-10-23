import { chmod, lstat, mkdir, unlink } from "node:fs/promises";
import { connect, createServer, type Server, type Socket } from "node:net";
import { dirname } from "node:path";
import { BridgeError, toErrorPayload } from "../errors.js";
import type { Logger } from "../logging.js";
import type { TaskService } from "../core/task-service.js";
import { IpcParams, IpcRequestSchema, parseParams, type IpcResponse } from "./protocol.js";

export interface IpcServerOptions {
  socketPath: string;
  service: TaskService;
  logger: Logger;
  onShutdown?: () => Promise<void> | void;
}

const MAX_LINE_BYTES = 10 * 1024 * 1024;

export class IpcServer {
  private readonly server: Server;
  private readonly clients = new Set<Socket>();
  private closing = false;

  constructor(private readonly options: IpcServerOptions) {
    this.server = createServer((socket) => this.accept(socket));
  }

  async listen(): Promise<void> {
    await mkdir(dirname(this.options.socketPath), { recursive: true, mode: 0o700 });
    await chmod(dirname(this.options.socketPath), 0o700);
    await removeStaleSocket(this.options.socketPath);

    await new Promise<void>((resolve, reject) => {
      const onError = (error: NodeJS.ErrnoException) => {
        this.server.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        this.server.off("error", onError);
        resolve();
      };
      this.server.once("error", onError);
      this.server.once("listening", onListening);
      this.server.listen(this.options.socketPath);
    });

    await chmod(this.options.socketPath, 0o600);
    this.options.logger.info({ socket: this.options.socketPath }, "bridge IPC server listening");
  }

  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    for (const client of this.clients) client.destroy();
    this.clients.clear();
    await new Promise<void>((resolve) => {
      if (!this.server.listening) {
        resolve();
        return;
      }
      this.server.close(() => resolve());
    });
    await unlink(this.options.socketPath).catch(() => undefined);
    this.options.logger.info("bridge IPC server closed");
  }

  private accept(socket: Socket): void {
    this.clients.add(socket);
    socket.setEncoding("utf8");
    let buffer = "";
    let bytes = 0;

    socket.on("data", (chunk: string) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > MAX_LINE_BYTES) {
        socket.destroy();
        return;
      }
      buffer += chunk;
      while (true) {
        const newline = buffer.indexOf("\n");
        if (newline === -1) return;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        bytes = Buffer.byteLength(buffer);
        if (line.trim() === "") continue;
        void this.handleLine(socket, line);
      }
    });
    socket.on("close", () => this.clients.delete(socket));
    socket.on("error", () => this.clients.delete(socket));
  }

  private async handleLine(socket: Socket, line: string): Promise<void> {
    let id = "unknown";
    try {
      const request = IpcRequestSchema.parse(JSON.parse(line));
      id = request.id;
      const result = await this.dispatch(request.method, request.params);
      this.write(socket, { id, ok: true, result });
    } catch (error) {
      this.write(socket, { id, ok: false, error: toErrorPayload(error) });
    }
  }

  private async dispatch(method: string, params: unknown): Promise<unknown> {
    switch (method) {
      case "spawn":
        return this.options.service.spawn(parseParams(IpcParams.spawn, params));
      case "status":
        return this.options.service.status(parseParams(IpcParams.status, params).task_id);
      case "history": {
        const parsed = parseParams(IpcParams.history, params);
        return this.options.service.history(parsed.task_id, {
          limit: parsed.limit,
          ...(parsed.cursor === undefined ? {} : { cursor: parsed.cursor }),
          ...(parsed.types === undefined ? {} : { types: parsed.types }),
        });
      }
      case "message": {
        const parsed = parseParams(IpcParams.message, params);
        return this.options.service.message(parsed.task_id, parsed.message);
      }
      case "abort":
        return this.options.service.abort(parseParams(IpcParams.abort, params).task_id);
      case "diff": {
        const parsed = parseParams(IpcParams.diff, params);
        return this.options.service.diff(parsed.task_id, {
          ...(parsed.file === undefined ? {} : { file: parsed.file }),
          ...(parsed.max_chars === undefined ? {} : { maxChars: parsed.max_chars }),
        });
      }
      case "list":
        return this.options.service.list(parseParams(IpcParams.list, params));
      case "cleanup":
        return this.options.service.cleanup(parseParams(IpcParams.cleanup, params));
      case "approve_cleanup":
        return this.options.service.approveCleanup(
          parseParams(IpcParams.approve_cleanup, params).approval_id,
        );
      case "shutdown":
        if (this.options.onShutdown !== undefined) {
          setImmediate(() => {
            void this.options.onShutdown?.();
          });
        }
        return { shutting_down: true };
      default:
        throw new BridgeError("INVALID_ARGUMENT", `Unknown IPC method: ${method}`);
    }
  }

  private write(socket: Socket, response: IpcResponse): void {
    if (socket.destroyed) return;
    socket.write(`${JSON.stringify(response)}\n`);
  }
}

async function removeStaleSocket(socketPath: string): Promise<void> {
  const exists = await lstat(socketPath).then(
    () => true,
    () => false,
  );
  if (!exists) return;

  const live = await new Promise<boolean>((resolve) => {
    const socket = connect(socketPath);
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, 200);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
  });

  if (live) {
    throw new BridgeError("DAEMON_UNAVAILABLE", `Bridge daemon is already listening at ${socketPath}`);
  }
  await unlink(socketPath).catch(() => undefined);
}
