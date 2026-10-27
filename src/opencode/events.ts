import type { TaskSource } from "../types.js";
import type { OpenCodeEvent } from "./types.js";

export interface MappedOpenCodeEvent {
  source: TaskSource;
  event_type: string;
  payload: Record<string, unknown>;
}

const toolEvents: Record<string, { eventType: string; source: TaskSource }> = {
  "session.tool.called": { eventType: "tool.called", source: "tool" },
  "session.tool.progress": { eventType: "tool.progress", source: "tool" },
  "session.tool.success": { eventType: "tool.completed", source: "tool" },
  "session.tool.failed": { eventType: "tool.failed", source: "tool" },
  "session.shell.started": { eventType: "shell.started", source: "tool" },
  "session.shell.ended": { eventType: "shell.ended", source: "tool" },
};

const stepEvents = new Set([
  "session.step.started",
  "session.step.ended",
  "session.step.failed",
  "session.prompt.admitted",
  "session.prompted",
  "session.retried",
  "session.compaction.started",
  "session.compaction.ended",
  "session.execution.started",
  "session.execution.succeeded",
  "session.execution.failed",
  "session.inbox.enqueued",
  "session.inbox.delivered",
]);

// OpenCode 2.1.2 emits session.tool/step/text.*; retain older session.next.* support.
function canonicalType(type: string): string {
  return type.replace(/^session\.next\./, "session.");
}

export function sessionIdFromEvent(event: OpenCodeEvent): string | null {
  return findString(event.data, "sessionID");
}

export function isEventForSession(event: OpenCodeEvent, sessionId: string): boolean {
  return sessionIdFromEvent(event) === sessionId;
}

export function isIdleEvent(event: OpenCodeEvent): boolean {
  if (event.type === "session.idle") return true;
  if (event.type !== "session.status") return false;
  return findString(event.data, "type", ["status"]) === "idle";
}

export function isErrorEvent(event: OpenCodeEvent): boolean {
  const type = canonicalType(event.type);
  return type === "session.error" || type === "session.step.failed" || type === "session.execution.failed";
}

export function eventErrorMessage(event: OpenCodeEvent): string {
  return (
    findString(event.data, "message") ??
    findString(event.data, "error") ??
    "OpenCode reported a session error"
  );
}

export function mapOpenCodeEvent(event: OpenCodeEvent): MappedOpenCodeEvent | null {
  const type = canonicalType(event.type);
  const tool = toolEvents[type];
  if (tool !== undefined) {
    return {
      source: tool.source,
      event_type: tool.eventType,
      payload: asPayload(event.data),
    };
  }

  if (event.type === "permission.asked" || event.type === "permission.v2.asked") {
    return {
      source: "opencode",
      event_type: "permission.requested",
      payload: asPayload(event.data),
    };
  }

  if (event.type === "permission.replied" || event.type === "permission.v2.replied") {
    return {
      source: "opencode",
      event_type: "permission.replied",
      payload: asPayload(event.data),
    };
  }

  if (event.type === "session.idle") {
    return {
      source: "opencode",
      event_type: "session.idle",
      payload: asPayload(event.data),
    };
  }

  if (event.type === "session.error") {
    return {
      source: "system",
      event_type: "opencode.error",
      payload: { ...asPayload(event.data), message: eventErrorMessage(event) },
    };
  }

  if (event.type === "session.status") {
    return {
      source: "opencode",
      event_type: "opencode.status",
      payload: asPayload(event.data),
    };
  }

  if (stepEvents.has(type)) {
    return {
      source: "opencode",
      event_type: `opencode.${type.slice("session.".length)}`,
      payload: asPayload(event.data),
    };
  }

  if (
    event.type === "message.updated" ||
    event.type === "message.part.updated" ||
    event.type === "message.part.delta" ||
    type.startsWith("session.text.") ||
    type.startsWith("session.reasoning.")
  ) {
    return null;
  }

  return {
    source: "opencode",
    event_type: "opencode.event",
    payload: { type: event.type, data: event.data },
  };
}

function asPayload(value: unknown): Record<string, unknown> {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return { value };
}

function findString(
  value: unknown,
  key: string,
  path: string[] = [],
  depth = 0,
): string | null {
  if (depth > 5 || typeof value !== "object" || value === null) return null;

  let current: unknown = value;
  for (const segment of path) {
    if (typeof current !== "object" || current === null) return null;
    current = (current as Record<string, unknown>)[segment];
  }

  if (typeof current === "object" && current !== null && !Array.isArray(current)) {
    const direct = (current as Record<string, unknown>)[key];
    if (typeof direct === "string") return direct;
  }

  for (const entry of Object.values(value as Record<string, unknown>)) {
    const nested = findString(entry, key, path, depth + 1);
    if (nested !== null) return nested;
  }
  return null;
}
