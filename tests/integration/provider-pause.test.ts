import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createServices } from "../../src/app.js";
import type {
  AbortResult,
  AdapterContext,
  AdapterProbe,
  AdapterRunResult,
  AdapterSession,
  AgentAdapter,
} from "../../src/adapters/adapter.js";
import { BridgeError } from "../../src/errors.js";
import { createLogger } from "../../src/logging.js";
import { emptyUsage, type TaskRecord } from "../../src/types.js";
import { createHarness, spawnInput } from "../helpers/fixtures.js";

class PauseOnceAdapter implements AgentAdapter {
  readonly name = "pause-test";
  readonly supportsWrites = true;
  readonly requiresIsolatedWorktree = false;
  private calls = 0;

  async probe(): Promise<AdapterProbe> {
    return { name: this.name, version: "1", compatible: true };
  }

  buildPrompt(task: TaskRecord): string {
    return task.task;
  }

  async start(
    task: TaskRecord,
    _prompt: string,
    context: AdapterContext,
  ): Promise<AdapterRunResult> {
    this.calls += 1;
    if (this.calls === 1) {
      throw new BridgeError("PROVIDER_AUTH_FAILED", "account blocked");
    }
    context.onSession({
      id: "pause_sess",
      model: task.model,
      provider_id: task.provider_id,
      worktree_path: null,
    });
    return { summary: "resumed", usage: emptyUsage() };
  }

  async abort(_session: AdapterSession): Promise<AbortResult> {
    return { stopped: true };
  }
}

describe("provider pause circuit breaker", () => {
  it("pauses new delegations after an account error and requires a local resume", async () => {
    const h = await createHarness();
    const config = { ...h.config, data_dir: join(h.tempDir, "pause-data") };
    const services = createServices(config, new PauseOnceAdapter(), createLogger("silent"));
    try {
      const first = await services.manager.spawn(spawnInput(h.repoRoot));
      const failed = await services.manager.waitForTerminal(first.task.task_id, 5000);
      expect(failed?.status).toBe("failed");
      expect(failed?.error?.code).toBe("PROVIDER_AUTH_FAILED");

      const paused = await services.service.capabilities();
      expect(paused.provider_paused).toMatchObject({ code: "PROVIDER_AUTH_FAILED" });

      await expect(
        services.service.spawn(spawnInput(h.repoRoot)),
      ).rejects.toMatchObject({ code: "PROVIDER_PAUSED" });
      await expect(
        services.service.preflight({ repo_root: h.repoRoot, read_only: false }),
      ).rejects.toMatchObject({ code: "PROVIDER_PAUSED" });

      expect(await services.service.resumeProvider()).toEqual({ resumed: true });
      expect((await services.service.capabilities()).provider_paused).toBeNull();

      const resumed = await services.service.spawn(spawnInput(h.repoRoot));
      const completed = await services.manager.waitForTerminal(resumed.task.task_id, 5000);
      expect(completed?.status).toBe("completed");
    } finally {
      await services.manager.shutdown();
      await h.cleanup();
    }
  });
});
