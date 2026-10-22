import { BridgeError } from "../errors.js";
import type {
  OpenCodeCreateSessionInput,
  OpenCodeEvent,
  OpenCodeInfo,
  OpenCodeMessage,
  OpenCodeModel,
  OpenCodePromptInput,
  OpenCodeSession,
} from "./types.js";

export class OpenCodeHttpError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(status: number, message: string, body: unknown) {
    super(message);
    this.name = "OpenCodeHttpError";
    this.status = status;
    this.body = body;
  }
}

export interface OpenCodeHttpClientOptions {
  baseUrl: string;
  password: string;
  requestTimeoutMs?: number;
  fetchImpl?: typeof fetch;
}

interface ModelListResponse {
  data: OpenCodeModel[];
}

interface SessionResponse {
  data: OpenCodeSession;
}

interface SessionListResponse {
  data: OpenCodeSession[];
}

interface MessageListResponse {
  data: OpenCodeMessage[];
}

interface ActiveSessionsResponse {
  data: Record<string, unknown>;
}

interface InterruptResponse {
  interrupted: boolean;
}

export class OpenCodeHttpClient {
  readonly baseUrl: string;
  private readonly authorization: string;
  private readonly requestTimeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: OpenCodeHttpClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.authorization = `Basic ${Buffer.from(`opencode:${options.password}`).toString("base64")}`;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
  }

  async info(signal?: AbortSignal): Promise<OpenCodeInfo> {
    return this.requestJson<OpenCodeInfo>("GET", "/api/info", undefined, signal);
  }

  async models(signal?: AbortSignal): Promise<OpenCodeModel[]> {
    const response = await this.requestJson<ModelListResponse>("GET", "/api/model", undefined, signal);
    return response.data;
  }

  async createSession(input: OpenCodeCreateSessionInput, signal?: AbortSignal): Promise<OpenCodeSession> {
    const response = await this.requestJson<SessionResponse>(
      "POST",
      "/api/session",
      input as unknown as Record<string, unknown>,
      signal,
    );
    return response.data;
  }

  async prompt(sessionId: string, input: OpenCodePromptInput, signal?: AbortSignal): Promise<void> {
    await this.requestJson<unknown>(
      "POST",
      `/api/session/${encodeURIComponent(sessionId)}/prompt`,
      input as unknown as Record<string, unknown>,
      signal,
    );
  }

  async interrupt(sessionId: string, signal?: AbortSignal): Promise<boolean> {
    const response = await this.requestJson<InterruptResponse>(
      "POST",
      `/api/session/${encodeURIComponent(sessionId)}/interrupt?resume=false`,
      undefined,
      signal,
    );
    return response.interrupted === true;
  }

  async session(sessionId: string, signal?: AbortSignal): Promise<OpenCodeSession> {
    const response = await this.requestJson<SessionResponse>(
      "GET",
      `/api/session/${encodeURIComponent(sessionId)}`,
      undefined,
      signal,
    );
    return response.data;
  }

  async messages(sessionId: string, limit = 100, signal?: AbortSignal): Promise<OpenCodeMessage[]> {
    const response = await this.requestJson<MessageListResponse>(
      "GET",
      `/api/session/${encodeURIComponent(sessionId)}/message?limit=${encodeURIComponent(String(limit))}`,
      undefined,
      signal,
    );
    return response.data;
  }

  async activeSessions(signal?: AbortSignal): Promise<Record<string, unknown>> {
    const response = await this.requestJson<ActiveSessionsResponse>(
      "GET",
      "/api/session/active",
      undefined,
      signal,
    );
    return response.data;
  }

  async listSessions(signal?: AbortSignal): Promise<OpenCodeSession[]> {
    const response = await this.requestJson<SessionListResponse>("GET", "/api/session", undefined, signal);
    return response.data;
  }

  async *events(signal: AbortSignal): AsyncGenerator<OpenCodeEvent> {
    const response = await this.fetchImpl(`${this.baseUrl}/api/event`, {
      method: "GET",
      headers: {
        authorization: this.authorization,
        accept: "text/event-stream",
      },
      signal,
    });

    if (!response.ok) {
      throw new OpenCodeHttpError(
        response.status,
        `OpenCode event stream failed with HTTP ${response.status}`,
        await readBody(response),
      );
    }
    if (response.body === null) {
      throw new BridgeError("OPENCODE_UNAVAILABLE", "OpenCode event stream had no body");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");

        while (true) {
          const boundary = buffer.indexOf("\n\n");
          if (boundary === -1) break;
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const event = parseEventFrame(frame);
          if (event !== null) yield event;
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  private async requestJson<T>(
    method: string,
    path: string,
    body?: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<T> {
    const headers: Record<string, string> = {
      authorization: this.authorization,
      accept: "application/json",
    };
    if (body !== undefined) headers["content-type"] = "application/json";

    const timeout = AbortSignal.timeout(this.requestTimeoutMs);
    const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: combined,
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new BridgeError("OPENCODE_UNAVAILABLE", "OpenCode request failed", {
        retryable: true,
        cause: error,
        details: { path },
      });
    }

    if (!response.ok) {
      throw new OpenCodeHttpError(
        response.status,
        `OpenCode request failed with HTTP ${response.status} ${response.statusText}`,
        await readBody(response),
      );
    }

    if (response.status === 204) return undefined as T;
    const payload = await readBody(response);
    return payload as T;
  }
}

async function readBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text === "") return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function parseEventFrame(frame: string): OpenCodeEvent | null {
  let eventName: string | undefined;
  const dataLines: string[] = [];

  for (const line of frame.split("\n")) {
    if (line.startsWith(":")) continue;
    if (line.startsWith("event:")) {
      eventName = line.slice("event:".length).trim();
    } else if (line.startsWith("data:")) {
      dataLines.push(line.slice("data:".length).trimStart());
    }
  }

  if (dataLines.length === 0) return null;
  const raw = dataLines.join("\n");

  try {
    const parsed = JSON.parse(raw) as {
      id?: string;
      type?: string;
      data?: unknown;
    };
    const type = parsed.type ?? eventName;
    if (type === undefined || type === "") return null;
    return {
      ...(parsed.id === undefined ? {} : { id: parsed.id }),
      type,
      data: parsed.data ?? parsed,
    };
  } catch {
    if (eventName === undefined) return null;
    return { type: eventName, data: raw };
  }
}
