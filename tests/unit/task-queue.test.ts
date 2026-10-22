import { describe, expect, it } from "vitest";
import { TaskQueue } from "../../src/core/task-queue.js";

describe("TaskQueue", () => {
  it("is FIFO and reports positions", () => {
    const queue = new TaskQueue(3);
    expect(queue.enqueue("a")).toEqual({ ok: true });
    expect(queue.enqueue("b")).toEqual({ ok: true });
    expect(queue.position("a")).toBe(1);
    expect(queue.position("b")).toBe(2);
    expect(queue.dequeue()).toBe("a");
    expect(queue.dequeue()).toBe("b");
    expect(queue.dequeue()).toBeUndefined();
  });

  it("rejects when full and does not duplicate ids", () => {
    const queue = new TaskQueue(1);
    expect(queue.enqueue("a")).toEqual({ ok: true });
    expect(queue.enqueue("a")).toEqual({ ok: true });
    expect(queue.enqueue("b")).toEqual({ ok: false, reason: "full" });
    expect(queue.size).toBe(1);
  });

  it("removes queued ids and updates positions", () => {
    const queue = new TaskQueue(3);
    queue.enqueue("a");
    queue.enqueue("b");
    queue.enqueue("c");
    expect(queue.remove("b")).toBe(true);
    expect(queue.remove("nope")).toBe(false);
    expect(queue.snapshot()).toEqual(["a", "c"]);
    expect(queue.position("c")).toBe(2);
  });
});
