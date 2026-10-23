import { randomUUID } from "node:crypto";
import type { BridgeEvent, HistoryPage, HistoryQuery, TaskSource } from "../types.js";
import { Redactor } from "./redact.js";

export interface EventStoreOptions {
  redactor: Redactor;
  /** Conversation messages can be larger than ordinary audit payloads. */
  messageRedactor?: Redactor;
  maxPayloadChars: number;
  now?: () => Date;
}

export interface AppendEventOptions {
  maxPayloadChars?: number;
}

export class EventStore {
  private readonly eventsByTask = new Map<string, BridgeEvent[]>();
  private readonly redactor: Redactor;
  private readonly messageRedactor: Redactor;
  private readonly maxPayloadChars: number;
  private readonly now: () => Date;

  constructor(options: EventStoreOptions) {
    this.redactor = options.redactor;
    this.messageRedactor = options.messageRedactor ?? options.redactor;
    this.maxPayloadChars = options.maxPayloadChars;
    this.now = options.now ?? (() => new Date());
  }

  hydrate(events: readonly BridgeEvent[]): void {
    this.eventsByTask.clear();
    for (const event of events) {
      const list = this.eventsByTask.get(event.task_id) ?? [];
      list.push(event);
      this.eventsByTask.set(event.task_id, list);
    }
    for (const list of this.eventsByTask.values()) {
      list.sort((a, b) => a.sequence - b.sequence);
    }
  }

  append(
    taskId: string,
    sessionId: string | null,
    source: TaskSource,
    eventType: string,
    payload: Record<string, unknown>,
    options: AppendEventOptions = {},
  ): BridgeEvent {
    const events = this.eventsByTask.get(taskId) ?? [];
    const sequence = (events.at(-1)?.sequence ?? 0) + 1;
    const redactor = eventType === "opencode.message" ? this.messageRedactor : this.redactor;
    const redacted = redactor.redact(payload) as Record<string, unknown>;
    const maxChars = options.maxPayloadChars ?? this.maxPayloadChars;
    const serialized = JSON.stringify(redacted);

    const finalPayload =
      serialized.length <= maxChars
        ? redacted
        : {
            _truncated: true,
            original_chars: serialized.length,
            preview: serialized.slice(0, maxChars),
          };

    const event: BridgeEvent = {
      event_id: randomUUID(),
      task_id: taskId,
      session_id: sessionId,
      timestamp: this.now().toISOString(),
      sequence,
      source,
      event_type: eventType,
      payload: finalPayload,
    };

    events.push(event);
    this.eventsByTask.set(taskId, events);
    return event;
  }

  list(taskId: string, query: HistoryQuery): HistoryPage {
    const all = this.eventsByTask.get(taskId) ?? [];
    const filtered =
      query.types === undefined || query.types.length === 0
        ? all
        : all.filter((event) => query.types?.includes(event.event_type));

    if (query.after !== undefined) {
      const after = query.after;
      const events = filtered
        .filter((event) => event.sequence > after)
        .slice(0, query.limit);
      const last = events.at(-1)?.sequence ?? after;
      return {
        events,
        next_cursor: String(last),
        has_more: filtered.some((event) => event.sequence > last),
        total: filtered.length,
      };
    }

    const cursor = query.cursor === undefined ? null : Number.parseInt(query.cursor, 10);
    const eligible =
      cursor === null || Number.isNaN(cursor)
        ? filtered
        : filtered.filter((event) => event.sequence < cursor);

    const start = Math.max(0, eligible.length - query.limit);
    const events = eligible.slice(start);
    const hasMore = start > 0;
    const first = events[0];

    return {
      events,
      next_cursor: hasMore && first !== undefined ? String(first.sequence) : null,
      has_more: hasMore,
      total: filtered.length,
    };
  }

  last(taskId: string): BridgeEvent | undefined {
    return this.eventsByTask.get(taskId)?.at(-1);
  }

  count(taskId: string): number {
    return this.eventsByTask.get(taskId)?.length ?? 0;
  }
}
