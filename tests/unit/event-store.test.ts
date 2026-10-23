import { describe, expect, it } from "vitest";
import { EventStore } from "../../src/core/event-store.js";
import { Redactor } from "../../src/core/redact.js";

function makeStore(): EventStore {
  let tick = 0;
  return new EventStore({
    redactor: new Redactor({ maxStringChars: 100 }),
    maxPayloadChars: 1000,
    now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)),
  });
}

describe("EventStore", () => {
  it("assigns stable per-task sequences and paginates backwards", () => {
    const store = makeStore();
    for (let i = 1; i <= 5; i++) {
      store.append("task_a", null, "bridge", `event.${i}`, { i });
    }

    const latest = store.list("task_a", { limit: 2 });
    expect(latest.events.map((event) => event.sequence)).toEqual([4, 5]);
    expect(latest.has_more).toBe(true);
    expect(latest.next_cursor).toBe("4");

    const older = store.list("task_a", { limit: 2, cursor: "4" });
    expect(older.events.map((event) => event.sequence)).toEqual([2, 3]);
    expect(older.next_cursor).toBe("2");

    const oldest = store.list("task_a", { limit: 2, cursor: "2" });
    expect(oldest.events.map((event) => event.sequence)).toEqual([1]);
    expect(oldest.has_more).toBe(false);
    expect(oldest.next_cursor).toBeNull();
  });

  it("supports forward cursors for log following", () => {
    const store = makeStore();
    for (let i = 1; i <= 5; i++) {
      store.append("task_a", null, "bridge", `event.${i}`, { i });
    }

    const first = store.list("task_a", { limit: 2, after: 0 });
    expect(first.events.map((event) => event.sequence)).toEqual([1, 2]);
    expect(first.next_cursor).toBe("2");
    expect(first.has_more).toBe(true);

    const second = store.list("task_a", { limit: 2, after: 2 });
    expect(second.events.map((event) => event.sequence)).toEqual([3, 4]);

    const last = store.list("task_a", { limit: 2, after: 4 });
    expect(last.events.map((event) => event.sequence)).toEqual([5]);
    expect(last.has_more).toBe(false);
  });

  it("filters by event type", () => {
    const store = makeStore();
    store.append("task_a", null, "codex", "task.created", { a: 1 });
    store.append("task_a", null, "tool", "tool.called", { tool: "bash" });
    store.append("task_a", null, "tool", "tool.completed", { tool: "bash" });

    const page = store.list("task_a", { limit: 10, types: ["tool.called", "tool.completed"] });
    expect(page.events).toHaveLength(2);
    expect(page.total).toBe(2);
  });

  it("truncates oversized payloads after redaction", () => {
    const store = new EventStore({
      redactor: new Redactor({ maxStringChars: 1000 }),
      maxPayloadChars: 50,
    });
    const event = store.append("task_a", null, "bridge", "big", { data: "x".repeat(200) });
    expect(event.payload._truncated).toBe(true);
    expect(typeof event.payload.preview).toBe("string");
  });

  it("keeps conversation messages up to the message payload limit", () => {
    const store = new EventStore({
      redactor: new Redactor({ maxStringChars: 40 }),
      messageRedactor: new Redactor({ maxStringChars: 1000 }),
      maxPayloadChars: 50,
    });
    const text = "y".repeat(300);
    const event = store.append(
      "task_a",
      null,
      "opencode",
      "opencode.message",
      { role: "assistant", text },
      { maxPayloadChars: 2000 },
    );
    expect(event.payload).toEqual({ role: "assistant", text });
  });
});
