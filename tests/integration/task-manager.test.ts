import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { TaskStatus, TaskView } from "../../src/types.js";
import { createHarness, makeTempDir, spawnInput, type Harness } from "../helpers/fixtures.js";

async function waitForStatus(
  harness: Harness,
  taskId: string,
  statuses: TaskStatus[],
  timeoutMs = 5000,
): Promise<TaskView> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const view = harness.services.manager.status(taskId);
    if (statuses.includes(view.status)) return view;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${statuses.join(", ")}; last=${harness.services.manager.status(taskId).status}`);
}

describe("TaskManager with mock adapter", () => {
  it("runs a full task lifecycle and records auditable events", async () => {
    const harness = await createHarness();
    try {
      const spawned = await harness.services.manager.spawn(spawnInput(harness.repoRoot));
      expect(["queued", "preparing", "running"]).toContain(spawned.task.status);

      const finished = await harness.services.manager.waitForTerminal(spawned.task.task_id, 5000);
      expect(finished?.status).toBe("completed");
      expect(finished?.session_id).toMatch(/^mock_sess_/);
      expect(finished?.usage.input_tokens).toBe(120);
      expect(finished?.estimated_cost_usd).toBe(0);
      expect(finished?.cost_known).toBe(true);

      const history = harness.services.manager.history(spawned.task.task_id, { limit: 100 });
      expect(history.task.task).toContain("focused unit test");
      const types = history.events.map((event) => event.event_type);
      expect(types).toContain("task.created");
      expect(types).toContain("prompt.sent");
      expect(types).toContain("session.created");
      expect(types).toContain("tool.called");
      expect(types).toContain("tool.completed");
      expect(types).toContain("task.completed");

      const sequences = history.events.map((event) => event.sequence);
      expect(sequences).toEqual([...sequences].sort((a, b) => a - b));
      expect(new Set(sequences).size).toBe(sequences.length);
    } finally {
      await harness.cleanup();
    }
  });

  it("deduplicates identical idempotency keys", async () => {
    const harness = await createHarness();
    try {
      const input = spawnInput(harness.repoRoot, { idempotency_key: "same-request" });
      const first = await harness.services.manager.spawn(input);
      const second = await harness.services.manager.spawn(input);

      expect(second.deduplicated).toBe(true);
      expect(second.task.task_id).toBe(first.task.task_id);
      await harness.services.manager.waitForTerminal(first.task.task_id, 5000);
    } finally {
      await harness.cleanup();
    }
  });

  it("rejects an idempotency key used with different parameters", async () => {
    const harness = await createHarness();
    try {
      const input = spawnInput(harness.repoRoot, { idempotency_key: "conflict" });
      await harness.services.manager.spawn(input);
      await expect(
        harness.services.manager.spawn({ ...input, task: "A different task" }),
      ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    } finally {
      await harness.cleanup();
    }
  });

  it("enforces the queue limit", async () => {
    const harness = await createHarness({ maxConcurrent: 1, maxQueue: 1, scenario: "slow" });
    try {
      const first = await harness.services.manager.spawn(spawnInput(harness.repoRoot));
      await waitForStatus(harness, first.task.task_id, ["preparing", "running"]);
      const second = await harness.services.manager.spawn(
        spawnInput(harness.repoRoot, { task: "Second task" }),
      );
      expect(second.task.queue_position).toBe(1);
      await expect(
        harness.services.manager.spawn(spawnInput(harness.repoRoot, { task: "Third task" })),
      ).rejects.toMatchObject({ code: "QUEUE_FULL" });
    } finally {
      await harness.cleanup();
    }
  });

  it("aborts a running task and verifies cancellation", async () => {
    const harness = await createHarness({ scenario: "slow" });
    try {
      const spawned = await harness.services.manager.spawn(spawnInput(harness.repoRoot));
      await waitForStatus(harness, spawned.task.task_id, ["running"]);

      const aborted = await harness.services.manager.abort(spawned.task.task_id);
      expect(aborted.stopped).toBe(true);
      expect(aborted.already_terminal).toBe(false);
      expect(aborted.task.status).toBe("cancelled");

      const history = harness.services.manager.history(spawned.task.task_id, { limit: 50 });
      const types = history.events.map((event) => event.event_type);
      expect(types).toContain("task.cancelling");
      expect(types).toContain("task.cancelled");
    } finally {
      await harness.cleanup();
    }
  });


  it("continues a completed task in the same session as a new turn", async () => {
    const harness = await createHarness();
    try {
      const first = await harness.services.manager.spawn(spawnInput(harness.repoRoot));
      const completed = await harness.services.manager.waitForTerminal(first.task.task_id, 5000);
      expect(completed?.session_id).not.toBeNull();

      const followUp = await harness.services.manager.message(
        first.task.task_id,
        "Please add one more edge-case assertion.",
      );
      expect(followUp.task.parent_task_id).toBe(first.task.task_id);
      expect(followUp.task.root_task_id).toBe(first.task.task_id);
      expect(followUp.task.turn).toBe(2);
      expect(followUp.task.session_id).toBe(completed?.session_id);

      const child = await harness.services.manager.waitForTerminal(followUp.task.task_id, 5000);
      expect(child?.status).toBe("completed");
      expect(child?.session_id).toBe(completed?.session_id);

      const history = harness.services.manager.history(followUp.task.task_id, { limit: 100 });
      expect(history.events.map((event) => event.event_type)).toContain("task.resumed");
    } finally {
      await harness.cleanup();
    }
  });

  it("rejects messages while a task or its lineage is running", async () => {
    const harness = await createHarness({ scenario: "slow" });
    try {
      const spawned = await harness.services.manager.spawn(spawnInput(harness.repoRoot));
      await waitForStatus(harness, spawned.task.task_id, ["running"]);
      await expect(
        harness.services.manager.message(spawned.task.task_id, "follow up"),
      ).rejects.toMatchObject({ code: "TASK_BUSY" });
    } finally {
      await harness.cleanup();
    }
  });


  it("fails a task that exceeds its token budget", async () => {
    const harness = await createHarness({ maxTokens: 50 });
    try {
      const spawned = await harness.services.manager.spawn(spawnInput(harness.repoRoot));
      const finished = await harness.services.manager.waitForTerminal(spawned.task.task_id, 5000);
      expect(finished?.status).toBe("failed");
      expect(finished?.error?.code).toBe("BUDGET_EXCEEDED");
      const history = harness.services.manager.history(spawned.task.task_id, { limit: 100 });
      expect(history.events.map((event) => event.event_type)).toContain("task.budget_exceeded");
    } finally {
      await harness.cleanup();
    }
  });

  it("times out a task and stops the adapter", async () => {
    const harness = await createHarness({ scenario: "slow", maxTimeoutSeconds: 30 });
    try {
      const spawned = await harness.services.manager.spawn(
        spawnInput(harness.repoRoot, { timeout_seconds: 1 }),
      );
      const finished = await harness.services.manager.waitForTerminal(spawned.task.task_id, 4000);
      expect(finished?.status).toBe("timed_out");
      expect(finished?.error?.code).toBe("TASK_TIMEOUT");
    } finally {
      await harness.cleanup();
    }
  });

  it("marks adapter failures as failed", async () => {
    const harness = await createHarness({ scenario: "fail" });
    try {
      const spawned = await harness.services.manager.spawn(spawnInput(harness.repoRoot));
      const finished = await harness.services.manager.waitForTerminal(spawned.task.task_id, 5000);
      expect(finished?.status).toBe("failed");
      expect(finished?.error?.code).toBe("ADAPTER_ERROR");
    } finally {
      await harness.cleanup();
    }
  });

  it("rejects disallowed models, repos, non-Git writes, and invalid timeouts", async () => {
    const harness = await createHarness();
    try {
      await expect(
        harness.services.manager.spawn(spawnInput(harness.repoRoot, { model: "evil/model" })),
      ).rejects.toMatchObject({ code: "MODEL_NOT_ALLOWED" });

      await expect(
        harness.services.manager.spawn(spawnInput(harness.repoRoot, { timeout_seconds: 9999 })),
      ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });

      const outside = await makeTempDir();
      try {
        await expect(
          harness.services.manager.spawn(spawnInput(outside, { read_only: true })),
        ).rejects.toMatchObject({ code: "REPO_NOT_ALLOWED" });
      } finally {
        const { rm } = await import("node:fs/promises");
        await rm(outside, { recursive: true, force: true });
      }

      const plain = join(harness.tempDir, "plain");
      await mkdir(plain);
      await expect(
        harness.services.manager.spawn(spawnInput(plain, { read_only: false })),
      ).rejects.toMatchObject({ code: "REPO_NOT_GIT" });

      expect(() => harness.services.manager.status("task_missing")).toThrowError(
        expect.objectContaining({ code: "TASK_NOT_FOUND" }),
      );
    } finally {
      await harness.cleanup();
    }
  });

  it("lists tasks with filters", async () => {
    const harness = await createHarness();
    try {
      const spawned = await harness.services.manager.spawn(spawnInput(harness.repoRoot));
      await harness.services.manager.waitForTerminal(spawned.task.task_id, 5000);

      expect(harness.services.manager.list({ limit: 10 })).toHaveLength(1);
      expect(
        harness.services.manager.list({ limit: 10, status: "completed" }),
      ).toHaveLength(1);
      expect(
        harness.services.manager.list({ limit: 10, status: "failed" }),
      ).toHaveLength(0);
    } finally {
      await harness.cleanup();
    }
  });
});
