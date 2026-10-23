import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { createLogger } from "../../src/logging.js";
import { startModelGateway } from "../../src/opencode/model-gateway.js";

describe("local model gateway", () => {
  it("forwards /v1 requests, replaces the upstream authorization, and streams the response", async () => {
    let received: { path?: string; auth?: string; body?: string } = {};
    const upstream = createServer(async (req, res) => {
      let body = "";
      for await (const chunk of req) body += chunk;
      received = { path: req.url, auth: req.headers.authorization, body };
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write('data: {"choices":[{"delta":{"content":"ok"}}]}\n\n');
      res.end("data: [DONE]\n\n");
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const address = upstream.address();
    if (address === null || typeof address === "string") throw new Error("no upstream port");

    const gateway = await startModelGateway({
      upstreamBaseUrl: `http://127.0.0.1:${address.port}/v1`,
      apiKey: "real-secret",
      logger: createLogger("silent"),
    });
    try {
      const response = await fetch(`${gateway.url}/chat/completions`, {
        method: "POST",
        headers: {
          authorization: "Bearer bridge-local",
          "content-type": "application/json",
        },
        body: JSON.stringify({ model: "test", stream: true }),
      });
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("data: [DONE]");
      expect(received.path).toBe("/v1/chat/completions");
      expect(received.auth).toBe("Bearer real-secret");
      expect(received.body).toContain('"model":"test"');
    } finally {
      await gateway.stop();
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    }
  });

  it("rejects paths outside /v1", async () => {
    const gateway = await startModelGateway({
      upstreamBaseUrl: "http://127.0.0.1:1/v1",
      apiKey: null,
      logger: createLogger("silent"),
    });
    try {
      const response = await fetch(`http://127.0.0.1:${gateway.port}/other`);
      expect(response.status).toBe(404);
    } finally {
      await gateway.stop();
    }
  });
});
