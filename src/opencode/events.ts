import type { TaskSource } from "../types.js";
import type { OpenCodeEvent } from "./types.js";

export interface MappedOpenCodeEvent {
  source: TaskSource;
  event_type: string;
  payload: Record<string, unknown>;
}

const toolEvents: Record<string, { eventType: string; source: TaskSource }> = {
  "session.next.tool.called": { eventType: "tool.called", source: "tool" },
  "session.next.tool.progress": { eventType: "tool.progress", source: "tool" },
  "session.next.tool.success": { eventType: "tool.completed", source: "tool" },
  "session.next.tool.failed": { eventType: "tool.failed", source: "tool" },
  "session.next.shell.started": { eventType: "shell.started", source: "tool" },
  "session.next.shell.ended": { eventType: "shell.ended", source: "tool" },
};

const stepEvents = new Set([
  "session.next.step.started",
  "session.next.step.ended",
  "session.next.step.failed",
  "session.next.prompt.admitted",
  "session.next.prompted",
  "session.next.retried",
  "session.next.compaction.started",
  "session.next.compaction.ended",
]);

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
  return event.type === "session.error" || event.type === "session.next.step.failed";
}

export function eventErrorMessage(event: OpenCodeEvent): string {
  return (
    findString(event.data, "message") ??
    findString(event.data, "error") ??
    "OpenCode reported a session error"
  );
}

export function mapOpenCodeEvent(event: OpenCodeEvent): MappedOpenCodeEvent | null {
  const tool = toolEvents[event.type];
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

  if (stepEvents.has(event.type)) {
    return {
      source: "opencode",
      event_type: `opencode.${event.type.slice("session.next.".length)}`,
      payload: asPayload(event.data),
    };
  }

  if (
    event.type === "message.updated" ||
    event.type === "message.part.updated" ||
    event.type === "message.part.delta" ||
    event.type.startsWith("session.next.text.") ||
    event.type.startsWith("session.next.reasoning.")
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
