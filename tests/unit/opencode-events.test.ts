import { describe, expect, it } from "vitest";
import { isErrorEvent, mapOpenCodeEvent } from "../../src/opencode/events.js";

describe("OpenCode SSE event compatibility", () => {
  it.each(["session.", "session.next."])("maps %s tool and step events without inventing payload fields", (prefix) => {
    // Shape observed from the real 2.1.2 API: tool name is not supplied here.
    const data = { sessionID: "ses_test", id: "call_read", input: { path: "/workspace/package.json" }, executed: false };
    expect(mapOpenCodeEvent({ type: `${prefix}tool.called`, data })).toEqual({
      source: "tool", event_type: "tool.called", payload: data,
    });
    expect(mapOpenCodeEvent({ type: `${prefix}tool.success`, data })?.event_type).toBe("tool.completed");
    expect(mapOpenCodeEvent({ type: `${prefix}tool.failed`, data })?.event_type).toBe("tool.failed");
    expect(mapOpenCodeEvent({ type: `${prefix}step.started`, data })?.event_type).toBe("opencode.step.started");
    expect(isErrorEvent({ type: `${prefix}step.failed`, data })).toBe(true);
    expect(mapOpenCodeEvent({ type: `${prefix}text.delta`, data })).toBeNull();
    expect(mapOpenCodeEvent({ type: `${prefix}reasoning.delta`, data })).toBeNull();
  });

  it("recognizes execution failure but preserves unrelated new events", () => {
    expect(isErrorEvent({ type: "session.execution.failed", data: { sessionID: "ses_test" } })).toBe(true);
    expect(mapOpenCodeEvent({ type: "session.custom.event", data: { value: 1 } })).toEqual({
      source: "opencode", event_type: "opencode.event", payload: { type: "session.custom.event", data: { value: 1 } },
    });
  });
});
