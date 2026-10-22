import { BridgeError } from "../errors.js";
import type { TaskStatus } from "../types.js";

export const TERMINAL_STATUSES: readonly TaskStatus[] = [
  "completed",
  "failed",
  "timed_out",
  "cancelled",
  "interrupted",
  "blocked",
];

const transitions: Record<TaskStatus, readonly TaskStatus[]> = {
  queued: ["preparing", "cancelled", "blocked"],
  preparing: ["running", "failed", "cancelled", "timed_out", "interrupted", "blocked"],
  running: [
    "waiting_permission",
    "cancelling",
    "completed",
    "failed",
    "timed_out",
    "interrupted",
  ],
  waiting_permission: ["running", "cancelling", "failed", "timed_out", "interrupted"],
  cancelling: ["cancelled", "interrupted", "failed"],
  completed: [],
  failed: [],
  timed_out: [],
  cancelled: [],
  interrupted: [],
  blocked: [],
};

export function isTerminal(status: TaskStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return transitions[from].includes(to);
}

export function assertTransition(from: TaskStatus, to: TaskStatus): void {
  if (!canTransition(from, to)) {
    throw new BridgeError(
      "INVALID_STATE_TRANSITION",
      `Illegal task state transition: ${from} -> ${to}`,
      { details: { from, to } },
    );
  }
}

export function allowedTransitions(status: TaskStatus): readonly TaskStatus[] {
  return transitions[status];
}
