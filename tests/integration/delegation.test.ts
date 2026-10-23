import { describe, expect, it } from "vitest";
import { createHarness, spawnInput } from "../helpers/fixtures.js";

describe("delegation discovery and waiting", () => {
  it("reports policy and soft limits without probing or invoking the adapter", async () => {
    const h = await createHarness({ maxTokens: 1000 });
    try {
      h.config.models.allow.push("mock/premium");
      h.config.models.expensive.push("mock/premium");
      h.adapter.probe = async () => { throw new Error("must not probe"); };
      h.adapter.start = async () => { throw new Error("must not run"); };
      const capabilities = await h.services.service.capabilities();
      expect(capabilities.simulated).toBe(true);
      expect(capabilities.models.allowed).toEqual([
        { model: "mock/echo", permitted: true, error_code: null },
        { model: "mock/premium", permitted: false, error_code: "MODEL_UPGRADE_REQUIRED" },
      ]);
      expect(capabilities.models.availability).toBe("validated_at_task_start");
      expect(capabilities.budgets).toMatchObject({ max_tokens: 1000, enforcement: "soft" });
      expect(capabilities.execution.write_isolation).toBe("simulated");
      expect(h.services.manager.list({ limit: 10 })).toEqual([]);
    } finally { await h.cleanup(); }
  });

  it("returns all snapshots when any task finishes and deduplicates IDs", async () => {
    const h = await createHarness({ maxConcurrent: 1, delayMs: 200 });
    try {
      const first = await h.services.service.spawn(spawnInput(h.repoRoot));
      const second = await h.services.service.spawn(spawnInput(h.repoRoot));
      const result = await h.services.service.wait({
        task_ids: [first.task.task_id, second.task.task_id, first.task.task_id],
        timeout_seconds: 3,
      });
      expect(result.timed_out).toBe(false);
      expect(result.ready_task_ids).toEqual([first.task.task_id]);
      expect(result.tasks).toHaveLength(2);
      expect(result.tasks[0]?.status).toBe("completed");
      expect(result.tasks[1]?.status).not.toBe("completed");
    } finally { await h.cleanup(); }
  });

  it("returns on deadline without stopping the task or duplicating model calls", async () => {
    const h = await createHarness({ scenario: "slow" });
    try {
      const { task } = await h.services.service.spawn(spawnInput(h.repoRoot));
      const input = { task_ids: [task.task_id], timeout_seconds: 0 };
      expect(await h.services.service.wait(input)).toMatchObject({ timed_out: true, ready_task_ids: [] });
      expect(await h.services.service.wait({ ...input, timeout_seconds: 1 })).toMatchObject({
        timed_out: true, ready_task_ids: [],
      });
      expect(h.services.manager.status(task.task_id).status).toBe("running");
      expect(h.services.manager.history(task.task_id, { limit: 100 }).events
        .filter((event) => event.event_type === "prompt.sent")).toHaveLength(1);
      await h.services.service.abort(task.task_id);
      expect(await h.services.service.wait(input)).toMatchObject({
        timed_out: false, ready_task_ids: [task.task_id],
      });
    } finally { await h.cleanup(); }
  });

  it("validates every target and bounds even for direct service callers", async () => {
    const h = await createHarness();
    try {
      const { task } = await h.services.service.spawn(spawnInput(h.repoRoot));
      await h.services.manager.waitForTerminal(task.task_id, 5000);
      await expect(h.services.service.wait({ task_ids: [task.task_id, "missing"], timeout_seconds: 3 }))
        .rejects.toMatchObject({ code: "TASK_NOT_FOUND" });
      for (const input of [
        { task_ids: [], timeout_seconds: 1 },
        { task_ids: Array(9).fill(task.task_id) as string[], timeout_seconds: 1 },
        { task_ids: [task.task_id], timeout_seconds: 51 },
        { task_ids: [task.task_id], timeout_seconds: -1 },
      ]) {
        await expect(h.services.service.wait(input)).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
      }
    } finally { await h.cleanup(); }
  });

  it("cancels a local wait without aborting the delegated task", async () => {
    const h = await createHarness({ scenario: "slow" });
    try {
      const { task } = await h.services.service.spawn(spawnInput(h.repoRoot));
      const controller = new AbortController();
      const waiting = h.services.service.wait({ task_ids: [task.task_id], timeout_seconds: 50 }, controller.signal);
      controller.abort();
      await expect(waiting).rejects.toMatchObject({ name: "AbortError" });
      expect(h.services.manager.status(task.task_id).status).not.toBe("cancelled");
    } finally { await h.cleanup(); }
  });

  it("wakes for a permission request without treating it as completion", async () => {
    const h = await createHarness({ scenario: "slow" });
    try {
      const start = h.adapter.start.bind(h.adapter);
      h.adapter.start = (task, prompt, context) => start(task, prompt, {
        ...context,
        emit(event) {
          context.emit(event);
          if (event.event_type === "opencode.prompt.received") {
            context.emit({ source: "opencode", event_type: "permission.requested", payload: {} });
          }
        },
      });
      const { task } = await h.services.service.spawn(spawnInput(h.repoRoot));
      const waited = await h.services.service.wait({ task_ids: [task.task_id], timeout_seconds: 3 });
      expect(waited.ready_task_ids).toEqual([task.task_id]);
      expect(waited.tasks[0]?.status).toBe("waiting_permission");
    } finally { await h.cleanup(); }
  });
});
