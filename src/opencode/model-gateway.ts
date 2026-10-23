import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { request as httpsRequest } from "node:https";
import type { Socket } from "node:net";
import { BridgeError } from "../errors.js";
import type { Logger } from "../logging.js";

export interface ModelGatewayOptions {
  upstreamBaseUrl: string;
  apiKey: string | null;
  logger: Logger;
}

export interface ModelGateway {
  /** OpenAI-compatible base URL, including /v1. */
  url: string;
  port: number;
  upstream: string;
  stop(): Promise<void>;
}

/**
 * Local OpenAI-compatible gateway. The sandboxed OpenCode process only knows
 * the localhost URL and a dummy key; this process injects the upstream key and
 * is the only component allowed to reach the provider.
 */
export async function startModelGateway(options: ModelGatewayOptions): Promise<ModelGateway> {
  let upstream: URL;
  try {
    upstream = new URL(options.upstreamBaseUrl);
  } catch (error) {
    throw new BridgeError("MODEL_GATEWAY_UNAVAILABLE", "Invalid upstream model URL", {
      cause: error,
    });
  }
  if (upstream.protocol !== "http:" && upstream.protocol !== "https:") {
    throw new BridgeError("MODEL_GATEWAY_UNAVAILABLE", "Model gateway only supports HTTP(S) upstreams");
  }

  const sockets = new Set<Socket>();
  const server = createServer((req, res) => {
    void handleRequest(req, res).catch((error: unknown) => {
      options.logger.warn(
        { error: error instanceof Error ? error.message : String(error) },
        "model gateway request failed",
      );
      if (!res.headersSent) {
        res.writeHead(502, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "Bridge model gateway failed" } }));
      } else {
        res.end();
      }
    });
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(0, "127.0.0.1");
  });

  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new BridgeError("MODEL_GATEWAY_UNAVAILABLE", "Model gateway did not bind a local port");
  }

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const incoming = new URL(req.url ?? "/", "http://127.0.0.1");
    if (!incoming.pathname.startsWith("/v1/")) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Only /v1/* is available through this gateway" } }));
      return;
    }
    if (req.method !== "GET" && req.method !== "POST") {
      res.writeHead(405, { "allow": "GET, POST", "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Method not allowed" } }));
      return;
    }

    const suffix = incoming.pathname.slice("/v1".length);
    const basePath = upstream.pathname.replace(/\/+$/, "");
    const targetPath = `${basePath}${suffix}${incoming.search}`;
    const headers: Record<string, string | string[]> = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (value === undefined) continue;
      if (["host", "authorization", "content-length", "connection"].includes(key.toLowerCase())) continue;
      headers[key] = value;
    }
    if (options.apiKey !== null && options.apiKey !== "") {
      headers.authorization = `Bearer ${options.apiKey}`;
    }

    const transport = upstream.protocol === "https:" ? httpsRequest : httpRequest;
    const upstreamRequest = transport(
      {
        protocol: upstream.protocol,
        hostname: upstream.hostname,
        port: upstream.port === "" ? undefined : Number(upstream.port),
        method: req.method,
        path: targetPath,
        headers,
      },
      (upstreamResponse) => {
        const responseHeaders: Record<string, string | string[]> = {};
        for (const [key, value] of Object.entries(upstreamResponse.headers)) {
          if (value === undefined) continue;
          if (["connection", "transfer-encoding"].includes(key.toLowerCase())) continue;
          responseHeaders[key] = value;
        }
        res.writeHead(upstreamResponse.statusCode ?? 502, responseHeaders);
        upstreamResponse.pipe(res);
      },
    );

    upstreamRequest.on("error", (error) => {
      if (!res.headersSent) {
        res.writeHead(502, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: `Upstream model request failed: ${error.message}` } }));
      } else {
        res.end();
      }
    });
    req.pipe(upstreamRequest);
    res.once("close", () => {
      if (!res.writableEnded) upstreamRequest.destroy();
    });
  }

  return {
    url: `http://127.0.0.1:${address.port}/v1`,
    port: address.port,
    upstream: upstream.origin + upstream.pathname,
    async stop() {
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
