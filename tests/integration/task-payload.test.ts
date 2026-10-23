import { describe, expect, it } from "vitest";
import { taskPayload } from "../../src/mcp/task-payload.js";
import { createHarness, spawnInput } from "../helpers/fixtures.js";

describe("compact MCP status output", () => {
  it("bounds a large worker answer and preserves complete readback without mutating persisted data", async () => {
    const h = await createHarness();
    try {
      const { task } = await h.services.service.spawn(spawnInput(h.repoRoot));
      const view = await h.services.manager.waitForTerminal(task.task_id, 5000);
      expect(view).not.toBeNull();
      const largeAnswer = "完整结果🙂".repeat(10_000);
      const largeView = { ...view!, result_summary: largeAnswer };
      const compact = taskPayload(largeView, "summary");
      expect(compact.result_summary_truncated).toBe(true);
      expect(String(compact.result_summary).length).toBeLessThanOrEqual(2000);
      expect(JSON.stringify(compact).length).toBeLessThan(4000);
      expect(compact.estimated_cost_usd).toBe(0);
      expect(taskPayload(largeView, "full").result_summary).toBe(largeAnswer);
      expect(largeView.result_summary).toBe(largeAnswer);
      expect((await h.services.service.status(task.task_id)).result_summary).toBe(view?.result_summary);
    } finally { await h.cleanup(); }
  });
});
