import { describe, expect, it } from "vitest";
import { BridgeError } from "../../src/errors.js";
import {
  allowedTransitions,
  assertTransition,
  canTransition,
  isTerminal,
  TERMINAL_STATUSES,
} from "../../src/core/task-state.js";
import type { TaskStatus } from "../../src/types.js";

const legal: Array<[TaskStatus, TaskStatus]> = [
  ["queued", "preparing"],
  ["queued", "cancelled"],
  ["queued", "blocked"],
  ["preparing", "running"],
  ["preparing", "failed"],
  ["preparing", "cancelled"],
  ["preparing", "timed_out"],
  ["preparing", "interrupted"],
  ["running", "waiting_permission"],
  ["running", "cancelling"],
  ["running", "completed"],
  ["running", "failed"],
  ["running", "timed_out"],
  ["running", "interrupted"],
  ["waiting_permission", "running"],
  ["waiting_permission", "cancelling"],
  ["waiting_permission", "timed_out"],
  ["cancelling", "cancelled"],
  ["cancelling", "interrupted"],
  ["cancelling", "failed"],
];

describe("task state machine", () => {
  it.each(legal)("allows %s -> %s", (from, to) => {
    expect(canTransition(from, to)).toBe(true);
    expect(() => assertTransition(from, to)).not.toThrow();
  });

  it("rejects illegal transitions", () => {
    expect(canTransition("completed", "running")).toBe(false);
    expect(canTransition("queued", "completed")).toBe(false);
    expect(canTransition("cancelled", "cancelling")).toBe(false);
    expect(() => assertTransition("completed", "running")).toThrow(BridgeError);
  });

  it("treats all terminal states as terminal and rejects outgoing transitions", () => {
    for (const status of TERMINAL_STATUSES) {
      expect(isTerminal(status)).toBe(true);
      expect(allowedTransitions(status)).toEqual([]);
    }
    for (const status of ["queued", "preparing", "running", "waiting_permission", "cancelling"] as const) {
      expect(isTerminal(status)).toBe(false);
    }
  });
});
