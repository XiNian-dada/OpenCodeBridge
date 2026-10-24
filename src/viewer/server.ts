import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { TaskService } from "../core/task-service.js";
import { isBridgeError } from "../errors.js";
import type { Logger } from "../logging.js";
import { taskPayload } from "../mcp/task-payload.js";
import type { TaskViewerInfo } from "../types.js";

const assets = new Map([
  ["/", { file: "index.html", type: "text/html; charset=utf-8" }],
  ["/app.js", { file: "app.js", type: "text/javascript; charset=utf-8" }],
  ["/style.css", { file: "style.css", type: "text/css; charset=utf-8" }],
]);

export interface ViewerOptions {
  service: TaskService;
  logger: Logger;
}

/** Read-only local UI. No filesystem, configuration or mutation endpoints. */
export class TaskViewer {
  private readonly token = randomBytes(32).toString("base64url");
  private readonly server = createServer((req, res) => {
    void this.handle(req, res).catch(() => {
      if (!res.headersSent) this.json(res, 500, { error: "读取记录失败" });
      else res.end();
    });
  });
  private origin = "";
  private focusedTask: string | null = null;
  constructor(private readonly options: ViewerOptions) {
    this.server.requestTimeout = 10_000;
    this.server.headersTimeout = 10_000;
  }

  async listen(): Promise<void> {
    // Fail startup if packaged assets are missing rather than serving a blank page.
    await Promise.all([...assets.values()].map((asset) => readFile(new URL(`./public/${asset.file}`, import.meta.url))));
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(0, "127.0.0.1", () => {
        this.server.off("error", reject);
        resolve();
      });
    });
    const address = this.server.address();
    if (address === null || typeof address === "string") throw new Error("Viewer failed to listen");
    this.origin = `http://127.0.0.1:${address.port}`;
  }

  info(): TaskViewerInfo {
    return { url: this.origin ? `${this.origin}/#key=${this.token}` : null, auto_open: false };
  }

  showTask(taskId: string): void {
    this.focusedTask = taskId;
  }

  async close(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
    this.origin = "";
  }

  private json(res: ServerResponse, status: number, data: unknown): void {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(data));
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    res.setHeader("cache-control", "no-store");
    res.setHeader("referrer-policy", "no-referrer");
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("x-frame-options", "DENY");
    res.setHeader("content-security-policy", "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
    // A strict Host check blocks DNS rebinding; no cross-origin responses or CORS.
    if (req.headers.host !== new URL(this.origin).host ||
        (req.headers.origin !== undefined && req.headers.origin !== this.origin) ||
        req.headers["sec-fetch-site"] === "cross-site") {
      this.json(res, 403, { error: "仅允许本机同源访问" });
      return;
    }
    if (req.method !== "GET") {
      res.setHeader("allow", "GET");
      this.json(res, 405, { error: "查看器只读" });
      return;
    }
    const url = new URL(req.url ?? "/", this.origin);
    const asset = assets.get(url.pathname);
    if (asset !== undefined) {
      const body = await readFile(new URL(`./public/${asset.file}`, import.meta.url));
      res.writeHead(200, { "content-type": asset.type });
      res.end(body);
      return;
    }
    const supplied = Buffer.from(req.headers.authorization ?? "");
    const expected = Buffer.from(`Bearer ${this.token}`);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      this.json(res, 401, { error: "请使用 bridge viewer 打开的私有链接" });
      return;
    }
    if (url.pathname === "/api/tasks") {
      const tasks = await this.options.service.list({ limit: 100 });
      this.json(res, 200, { focused_task_id: this.focusedTask, tasks: tasks.map((task) => ({ ...taskPayload(task, "summary"), created_at: task.created_at })) });
      return;
    }
    const match = /^\/api\/tasks\/([^/]+)\/events$/.exec(url.pathname);
    if (match !== null) {
      const afterText = url.searchParams.get("after") ?? "0";
      const after = Number(afterText);
      if (!/^\d+$/.test(afterText) || !Number.isSafeInteger(after)) {
        this.json(res, 400, { error: "无效的事件游标" });
        return;
      }
      try {
        const id = decodeURIComponent(match[1]!);
        const page = await this.options.service.history(id, { after, limit: 100 });
        const { task: _originalInstruction, ...metadata } = page.task;
        // Delegate/prompt text is rendered from redacted audit events, never raw TaskRecord.task.
        this.json(res, 200, { ...page, task: metadata });
      } catch (error) {
        this.json(res, isBridgeError(error) && error.code === "TASK_NOT_FOUND" ? 404 : 500, { error: "无法读取该任务记录" });
      }
      return;
    }
    this.json(res, 404, { error: "页面不存在" });
  }
}
