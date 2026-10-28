import { realpath, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createLogger } from "../../src/logging.js";
import { READ_ONLY_PERMISSIONS } from "../../src/opencode/adapter.js";
import { startModelGateway } from "../../src/opencode/model-gateway.js";
import { startManagedOpenCodeServer } from "../../src/opencode/process.js";
import { makeTempDir } from "../helpers/fixtures.js";

const live = process.env.OPENCODE_LIVE === "1";

describe.skipIf(!live)("live OpenCode 2.2 API smoke", () => {
  it("starts a read-only private server under the read-isolation sandbox", async () => {
    const dir = await realpath(await makeTempDir());
    let managed;
    try {
      managed = await startManagedOpenCodeServer({
        binary: process.env.OPENCODE_BIN ?? "/opt/homebrew/bin/opencode",
        cwd: dir,
        dataDir: join(dir, "data"),
        taskId: "task_live_read_smoke",
        configContent: { permissions: [...READ_ONLY_PERMISSIONS], snapshots: false },
        compatibility: "2.2.x",
        startupTimeoutMs: 15000,
        logger: createLogger("silent"),
        sandbox: { mode: "read", worktreePath: dir },
      });

      expect(managed.info.version).toMatch(/^2\.2\./);
      expect(managed.sandboxed).toBe(true);
      const models = await managed.client.models();
      expect(models.length).toBeGreaterThan(0);
    } finally {
      if (managed !== undefined) await managed.stop();
      await rm(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it("runs a gateway-backed session with isolated config and localhost-only networking", async () => {
    const dir = await realpath(await makeTempDir());
    let managed;
    let upstream;
    let gateway;
    try {
      upstream = createServer(async (req, res) => {
        let body = "";
        for await (const chunk of req) body += chunk;
        if (!req.url?.endsWith("/chat/completions")) {
          res.writeHead(404);
          res.end("{}");
          return;
        }
        const parsed = JSON.parse(body) as { stream?: boolean };
        if (parsed.stream === true) {
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.write(`data: ${JSON.stringify({ id: "chatcmpl-test", object: "chat.completion.chunk", created: 1, model: "test-model", choices: [{ index: 0, delta: { role: "assistant", content: "gateway reply" } }] })}\n\n`);
          res.write(`data: ${JSON.stringify({ id: "chatcmpl-test", object: "chat.completion.chunk", created: 1, model: "test-model", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 3, total_tokens: 4 } })}\n\n`);
          res.end("data: [DONE]\n\n");
        } else {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ id: "chatcmpl-test", object: "chat.completion", created: 1, model: "test-model", choices: [{ index: 0, message: { role: "assistant", content: "gateway reply" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 3, total_tokens: 4 } }));
        }
      });
      await new Promise<void>((resolve) => upstream!.listen(0, "127.0.0.1", resolve));
      const address = upstream.address();
      if (address === null || typeof address === "string") throw new Error("no upstream port");

      gateway = await startModelGateway({
        upstreamBaseUrl: `http://127.0.0.1:${address.port}/v1`,
        apiKey: "real-upstream-key",
        logger: createLogger("silent"),
      });

      managed = await startManagedOpenCodeServer({
        binary: process.env.OPENCODE_BIN ?? "/opt/homebrew/bin/opencode",
        cwd: dir,
        dataDir: join(dir, "data"),
        taskId: "task_live_gateway",
        configContent: {
          permissions: [...READ_ONLY_PERMISSIONS],
          snapshots: false,
          mcp: {},
          provider: {
            "bridge-gateway": {
              npm: "@ai-sdk/openai-compatible",
              name: "Bridge Gateway",
              options: { baseURL: gateway.url, apiKey: "bridge-local" },
              models: { "test-model": { name: "test-model" } },
            },
          },
        },
        compatibility: "2.2.x",
        startupTimeoutMs: 15000,
        logger: createLogger("silent"),
        homeDir: join(dir, "data", "tasks", "task_live_gateway", "home"),
        sandbox: {
          mode: "read",
          worktreePath: dir,
          gatewayPort: gateway.port,
          isolateConfig: true,
        },
      });

      expect(managed.sandboxed).toBe(true);
      const models = await managed.client.models();
      expect(models.some((model) => model.providerID === "bridge-gateway" && model.id === "test-model")).toBe(true);
      const session = await managed.client.createSession({
        title: "gateway live smoke",
        model: { providerID: "bridge-gateway", id: "test-model" },
      });
      await managed.client.prompt(session.id, { text: "Say hello" });

      let reply: string | null = null;
      for (let attempt = 0; attempt < 40; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        const messages = await managed.client.messages(session.id, 10);
        const assistant = messages.find((message) => message.type === "assistant" && Array.isArray(message.content));
        if (assistant !== undefined) {
          const content = assistant.content as Array<{ type?: string; text?: string }>;
          reply = content.find((part) => part.type === "text")?.text ?? null;
          if (reply !== null) break;
        }
      }
      expect(reply).toBe("gateway reply");
    } finally {
      if (managed !== undefined) await managed.stop();
      if (gateway !== undefined) await gateway.stop();
      if (upstream !== undefined) await new Promise<void>((resolve) => upstream!.close(() => resolve()));
      await rm(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it("starts a private server, creates a session, and admits a no-reply prompt", async () => {
    const dir = await realpath(await makeTempDir());
    let managed;
    try {
      managed = await startManagedOpenCodeServer({
        binary: process.env.OPENCODE_BIN ?? "/opt/homebrew/bin/opencode",
        cwd: dir,
        dataDir: join(dir, "data"),
        taskId: "task_live_smoke",
        configContent: { permissions: [...READ_ONLY_PERMISSIONS], snapshots: false },
        compatibility: "2.2.x",
        startupTimeoutMs: 15000,
        logger: createLogger("silent"),
        sandbox: { worktreePath: dir },
      });

      expect(managed.info.version).toMatch(/^2\.2\./);
      expect(managed.sandboxed).toBe(true);
      const models = await managed.client.models();
      const free = models.find(
        (model) =>
          Array.isArray(model.cost) &&
          model.cost.length > 0 &&
          model.cost.every((entry) => entry.input === 0 && entry.output === 0),
      );
      expect(free).toBeDefined();
      if (free === undefined) return;

      const session = await managed.client.createSession({
        title: "bridge live smoke",
        model: { providerID: free.providerID, id: free.id },
      });
      expect(session.id).toMatch(/^ses_/);

      await managed.client.prompt(session.id, {
        text: "API smoke only; do not invoke a model.",
        resume: false,
      });
      expect(await managed.client.interrupt(session.id)).toBe(false);

      const controller = new AbortController();
      const stream = managed.client.events(controller.signal);
      const first = await stream.next();
      expect(first.done).toBe(false);
      expect(first.value?.type).toBe("server.connected");
      controller.abort();
    } finally {
      if (managed !== undefined) await managed.stop();
      await rm(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
