import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

export type FakeScenario = "success" | "abort" | "error" | "followup-delay";

interface FakeSession {
  id: string;
  model: { id: string; providerID: string; variant?: string };
  messages: Array<Record<string, unknown>>;
  idle: boolean;
  outcome?: "succeeded" | "failed" | "interrupted";
  cost: number;
  tokens: {
    input: number;
    output: number;
    reasoning: number;
    cache: { read: number; write: number };
  };
  created: number;
  updated: number;
}

export interface FakeOpenCode {
  baseUrl: string;
  password: string;
  close(): Promise<void>;
}

export async function startFakeOpenCode(scenario: FakeScenario): Promise<FakeOpenCode> {
  const password = "fake-password";
  const expectedAuth = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`;
  const sessions = new Map<string, FakeSession>();
  const sseClients = new Set<ServerResponse>();
  let server: Server;

  function emit(sessionId: string, type: string, data: Record<string, unknown>): void {
    const frame = `data: ${JSON.stringify({
      id: `evt_${randomUUID()}`,
      type,
      data: { sessionID: sessionId, ...data },
    })}\n\n`;
    for (const client of sseClients) client.write(frame);
  }

  function complete(session: FakeSession): void {
    const turn = session.messages.filter((message) => message.type === "user").length;
    session.messages.push({
      id: `msg_assistant_${turn}`,
      time: { created: Date.now() },
      type: "assistant",
      content: [{ type: "text", text: `Fake task completed turn ${turn}` }],
    });
    session.tokens = {
      input: session.tokens.input + 10,
      output: session.tokens.output + 5,
      reasoning: session.tokens.reasoning,
      cache: { ...session.tokens.cache },
    };
    session.cost += 0.003;
    session.idle = true;
    session.outcome = "succeeded";
    session.updated = Date.now();
    emit(session.id, "session.step.ended", {
      finish: "stop",
      rawFinish: "stop",
      cost: session.cost,
      tokens: session.tokens,
    });
    emit(session.id, "session.usage.updated", {
      cost: session.cost,
      tokens: session.tokens,
    });
    emit(session.id, "session.execution.succeeded", {});
    emit(session.id, "session.idle", {});
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.headers.authorization !== expectedAuth) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ _tag: "UnauthorizedError", message: "Authentication required" }));
      return;
    }

    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const segments = url.pathname.split("/").filter(Boolean);

    if (req.method === "GET" && url.pathname === "/api/info") {
      json(res, 200, {
        version: "2.1.2",
        pid: process.pid,
        urls: ["http://127.0.0.1"],
        paths: { tmp: "/tmp" },
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/model") {
      json(res, 200, {
        data: [
          {
            id: "echo",
            modelID: "echo",
            providerID: "fake",
            name: "Fake Echo",
            cost: [{ input: 0, output: 0, cache: { read: 0, write: 0 } }],
          },
        ],
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/event") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      res.write(`data: ${JSON.stringify({ id: "evt_connected", type: "server.connected", data: {} })}\n\n`);
      sseClients.add(res);
      req.on("close", () => sseClients.delete(res));
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/session/active") {
      const active = [...sessions.values()].filter((session) => !session.idle);
      json(res, 200, {
        data: Object.fromEntries(active.map((session) => [session.id, { status: "running" }])),
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/session") {
      const body = await readJson(req);
      const model = (body.model as FakeSession["model"] | undefined) ?? {
        id: "echo",
        providerID: "fake",
      };
      const now = Date.now();
      const session: FakeSession = {
        id: `ses_${randomUUID()}`,
        model,
        messages: [],
        idle: true,
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        created: now,
        updated: now,
      };
      sessions.set(session.id, session);
      json(res, 200, { data: sessionInfo(session) });
      return;
    }

    if (segments[1] === "session" && segments[2] !== undefined) {
      const session = sessions.get(segments[2]);
      if (session === undefined) {
        json(res, 404, { _tag: "SessionNotFoundError", message: "Session not found" });
        return;
      }

      if (req.method === "GET" && segments.length === 3) {
        json(res, 200, { data: sessionInfo(session) });
        return;
      }

      if (req.method === "GET" && segments[3] === "message") {
        json(res, 200, { data: [...session.messages].reverse(), cursor: { previous: null, next: null } });
        return;
      }

      if (req.method === "POST" && segments[3] === "prompt") {
        const body = await readJson(req);
        session.idle = false;
        session.updated = Date.now();
        session.messages.push({
          id: `msg_${randomUUID()}`,
          time: { created: Date.now() },
          type: "user",
          payload: { text: body.text },
        });
        json(res, 200, { data: { id: "inbox", sessionID: session.id } });

        const turn = session.messages.filter((message) => message.type === "user").length;
        if (scenario === "success" || (scenario === "followup-delay" && turn === 1)) {
          setTimeout(() => {
            emit(session.id, "session.tool.called", {
              callID: "call_1",
              tool: "bash",
              input: { command: "echo fake" },
            });
            emit(session.id, "session.tool.success", {
              callID: "call_1",
              tool: "bash",
              output: "fake",
            });
            complete(session);
          }, 25);
        } else if (scenario === "followup-delay" && turn > 1) {
          // Reproduce the follow-up inbox window: the session is not active and
          // a stale idle event arrives before the new assistant answer exists.
          session.idle = true;
          session.updated = Date.now();
          setTimeout(() => emit(session.id, "session.idle", {}), 0);
          setTimeout(() => {
            session.idle = false;
            session.updated = Date.now();
            complete(session);
          }, 900);
        } else if (scenario === "error") {
          setTimeout(() => {
            session.idle = true;
            session.outcome = "failed";
            session.updated = Date.now();
            emit(session.id, "session.error", { message: "Fake provider error" });
            emit(session.id, "session.idle", {});
          }, 25);
        }
        return;
      }

      if (req.method === "POST" && segments[3] === "interrupt") {
        if (session.idle) {
          json(res, 200, { interrupted: false });
          return;
        }
        session.idle = true;
        session.outcome = "interrupted";
        session.updated = Date.now();
        emit(session.id, "session.idle", {});
        json(res, 200, { interrupted: true });
        return;
      }
    }

    json(res, 404, { _tag: "NotFound", message: `No route for ${req.method} ${url.pathname}` });
  }

  server = createServer((req, res) => {
    void handle(req, res).catch((error: unknown) => {
      json(res, 500, { _tag: "InternalError", message: String(error) });
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Fake server did not bind");

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    password,
    async close() {
      for (const client of sseClients) client.end();
      sseClients.clear();
      if (server.listening) {
        server.closeAllConnections();
        server.close();
        await once(server, "close");
      }
    },
  };
}

function sessionInfo(session: FakeSession): Record<string, unknown> {
  return {
    id: session.id,
    title: "fake session",
    model: session.model,
    cost: session.cost,
    tokens: session.tokens,
    time: {
      created: session.created,
      updated: session.updated,
      ...(session.idle ? { idle: session.updated } : {}),
    },
    ...(session.outcome === undefined ? {} : { outcome: session.outcome }),
    location: { directory: "/tmp" },
  };
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let body = "";
  for await (const chunk of req) body += chunk;
  if (body === "") return {};
  return JSON.parse(body) as Record<string, unknown>;
}
