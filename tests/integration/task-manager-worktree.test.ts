import { realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createServices } from "../../src/app.js";
import type { BridgeConfig } from "../../src/config.js";
import { createLogger } from "../../src/logging.js";
import type {
  AbortResult,
  AdapterContext,
  AdapterProbe,
  AdapterRunResult,
  AdapterSession,
  AgentAdapter,
} from "../../src/adapters/adapter.js";
import { emptyUsage, type TaskRecord } from "../../src/types.js";
import { makeGitRepo, makeTempDir } from "../helpers/fixtures.js";

class WritingAdapter implements AgentAdapter {
  readonly name = "writing-test";
  readonly supportsWrites = true;
  readonly requiresIsolatedWorktree = true;

  async probe(): Promise<AdapterProbe> {
    return { name: this.name, version: "1", compatible: true };
  }

  buildPrompt(task: TaskRecord): string {
    return task.task;
  }

  async start(task: TaskRecord, _prompt: string, context: AdapterContext): Promise<AdapterRunResult> {
    if (task.worktree_path === null) throw new Error("worktree missing");
    context.onSession({
      id: "ses_writing_test",
      model: task.model,
      provider_id: task.provider_id,
      worktree_path: task.worktree_path,
    });
    await writeFile(join(task.worktree_path, "new-file.txt"), "hello from adapter\n", "utf8");
    context.emit({
      source: "tool",
      event_type: "tool.called",
      payload: { tool: "write", path: "new-file.txt" },
    });
    return { summary: "wrote a file", usage: emptyUsage() };
  }

  async abort(_session: AdapterSession): Promise<AbortResult> {
    return { stopped: true };
  }
}

function config(tempDir: string): BridgeConfig {
  return {
    adapter: "mock",
    log_level: "silent",
    data_dir: join(tempDir, "data"),
    scheduler: {
      max_concurrent: 1,
      max_queue: 5,
      default_timeout_seconds: 30,
      max_timeout_seconds: 60,
    },
    models: {
      default: "mock/echo",
      allow: ["mock/echo"],
      expensive: [],
      allow_expensive: false,
      max_cost_usd: null,
      max_tokens: null,
    },
    security: {
      allowed_repo_roots: [tempDir],
      require_git_for_writes: true,
      allow_external_directories: false,
    },
    opencode: {
      binary: "opencode",
      compatibility: "2.1.x",
      startup_timeout_ms: 5000,
    },
    history: {
      default_limit: 20,
      max_limit: 100,
      max_payload_chars: 4000,
      max_delegation_chars: 50_000,
    },
    mock: { scenario: "success", delay_ms: 5 },
  };
}

describe("TaskManager worktree integration", () => {
  it("creates an isolated worktree, runs the adapter there, and exposes its diff", async () => {
    const dir = await realpath(await makeTempDir());
    const services = createServices(config(dir), new WritingAdapter(), createLogger("silent"));
    try {
      const repo = await makeGitRepo(dir);
      const spawned = await services.manager.spawn({
        task: "Write a new file.",
        repo_root: repo,
        task_type: "coding",
        model: "mock/echo",
        read_only: false,
        timeout_seconds: 10,
      });

      const finished = await services.manager.waitForTerminal(spawned.task.task_id, 5000);
      expect(finished?.status).toBe("completed");
      expect(finished?.worktree_path).not.toBeNull();
      expect(finished?.worktree_path).not.toBe(repo);

      const diff = await services.manager.diff(spawned.task.task_id);
      expect(diff.available).toBe(true);
      expect(diff.untracked).toContain("new-file.txt");
      expect(diff.patch).toContain("hello from adapter");

      const history = services.manager.history(spawned.task.task_id, { limit: 100 });
      const types = history.events.map((event) => event.event_type);
      expect(types).toContain("worktree.created");
      expect(types).toContain("prompt.sent");
    } finally {
      await services.manager.shutdown();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
