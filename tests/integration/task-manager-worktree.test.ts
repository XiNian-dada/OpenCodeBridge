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

  constructor(private readonly filename = "new-file.txt") {}

  async probe(): Promise<AdapterProbe> {
    return { name: this.name, version: "1", compatible: true };
  }

  buildPrompt(task: TaskRecord): string {
    return task.task;
  }

  async start(task: TaskRecord, _prompt: string, context: AdapterContext): Promise<AdapterRunResult> {
    if (task.worktree_path === null && !task.read_only) throw new Error("worktree missing");
    context.onSession({
      id: "ses_writing_test",
      model: task.model,
      provider_id: task.provider_id,
      worktree_path: task.worktree_path ?? task.workspace_path,
    });
    if (task.read_only) {
      return { summary: "read the managed workspace", usage: emptyUsage() };
    }
    await writeFile(join(task.worktree_path!, this.filename), "hello from adapter\n", "utf8");
    context.emit({
      source: "tool",
      event_type: "tool.called",
      payload: { tool: "write", path: this.filename },
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
      read_sandbox: "auto",
      model_gateway: "auto",
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

      const delivery = await services.service.delivery({ task_id: spawned.task.task_id });
      expect(delivery.git.available).toBe(true);
      expect(delivery.git.base_commit).toMatch(/^[0-9a-f]{40}$/);
      expect(delivery.git.patch).toContain("hello from adapter");
      expect(delivery.git.patch_sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(delivery.git.source).toBe("snapshot");
      expect(delivery.git.captured_at).not.toBeNull();
      expect(delivery.usage_scope).toBe("turn");
      expect(delivery.session_usage_scope).toBe("session");
      expect(delivery.verification.status).toBe("unverified");
      expect(delivery.verification.bridge_ran_commands).toBe(false);
      expect(delivery.git.files.some((file) => file.path === "new-file.txt")).toBe(true);

      const originalHash = delivery.git.patch_sha256;
      const originalPatch = delivery.git.patch;
      const worktreePath = finished?.worktree_path;
      expect(worktreePath).not.toBeNull();
      await writeFile(join(worktreePath!, "new-file.txt"), "coordinator edit after completion\n", "utf8");

      const afterEdit = await services.service.delivery({ task_id: spawned.task.task_id });
      expect(afterEdit.git.source).toBe("snapshot");
      expect(afterEdit.git.patch_sha256).toBe(originalHash);
      expect(afterEdit.git.patch).toBe(originalPatch);
      expect(afterEdit.git.patch).not.toContain("coordinator edit");

      await rm(worktreePath!, { recursive: true, force: true });
      const afterRemoval = await services.service.delivery({ task_id: spawned.task.task_id });
      expect(afterRemoval.git.available).toBe(true);
      expect(afterRemoval.git.source).toBe("snapshot");
      expect(afterRemoval.git.patch_sha256).toBe(originalHash);
      expect(afterRemoval.git.patch).toContain("hello from adapter");

      const metadataOnly = await services.service.delivery({
        task_id: spawned.task.task_id,
        include_patch: false,
      });
      expect(metadataOnly.git.source).toBe("snapshot");
      expect(metadataOnly.git.patch).toBe("");
      expect(metadataOnly.git.patch_included).toBe(false);
      expect(metadataOnly.git.patch_sha256).toBe(originalHash);
      expect(metadataOnly.git.patch_bytes).toBeGreaterThan(0);

      const smallDisplay = await services.service.delivery({
        task_id: spawned.task.task_id,
        max_chars: 1000,
      });
      expect(smallDisplay.git.patch_sha256).toBe(originalHash);
      expect(smallDisplay.git.patch.length).toBeLessThanOrEqual(1000 + 100);

      const removedDiff = await services.manager.diff(spawned.task.task_id);
      expect(removedDiff.available).toBe(false);
      expect(removedDiff.reason).toBe("workspace_removed");

      const history = services.manager.history(spawned.task.task_id, { limit: 100 });
      const types = history.events.map((event) => event.event_type);
      expect(types).toContain("worktree.created");
      expect(types).toContain("prompt.sent");
      expect(types).toContain("delivery.snapshot.created");
    } finally {
      await services.manager.shutdown();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("fails a task that edits outside write_paths and preserves its worktree", async () => {
    const dir = await realpath(await makeTempDir());
    const services = createServices(
      config(dir),
      new WritingAdapter("forbidden.txt"),
      createLogger("silent"),
    );
    try {
      const repo = await makeGitRepo(dir);
      const spawned = await services.manager.spawn({
        task: "Write only the allowed file.",
        repo_root: repo,
        task_type: "coding",
        model: "mock/echo",
        read_only: false,
        timeout_seconds: 10,
        write_paths: ["allowed.txt"],
      });

      const finished = await services.manager.waitForTerminal(spawned.task.task_id, 5000);
      expect(finished?.status).toBe("failed");
      expect(finished?.error?.code).toBe("SCOPE_VIOLATION");
      expect(finished?.worktree_path).not.toBeNull();

      const history = services.manager.history(spawned.task.task_id, { limit: 100 });
      const violation = history.events.find(
        (event) => event.event_type === "task.scope_violation",
      );
      expect(violation?.payload).toMatchObject({
        violations: ["forbidden.txt"],
        write_paths: ["allowed.txt"],
      });
      const delivery = await services.service.delivery({ task_id: spawned.task.task_id });
      expect(delivery.path_policy).toMatchObject({
        per_file_scope: true,
        write_paths: ["allowed.txt"],
        scope_violations: ["forbidden.txt"],
      });
      expect(delivery.artifacts.artifact_available).toBe(true);
      expect(delivery.verification.notes.join(" ")).toContain("outside the declared write_paths");
    } finally {
      await services.manager.shutdown();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("accepts a task that edits only within write_paths", async () => {
    const dir = await realpath(await makeTempDir());
    const services = createServices(
      config(dir),
      new WritingAdapter("allowed.txt"),
      createLogger("silent"),
    );
    try {
      const repo = await makeGitRepo(dir);
      const spawned = await services.manager.spawn({
        task: "Write only the allowed file.",
        repo_root: repo,
        task_type: "coding",
        model: "mock/echo",
        read_only: false,
        timeout_seconds: 10,
        write_paths: ["allowed.txt"],
      });

      const finished = await services.manager.waitForTerminal(spawned.task.task_id, 5000);
      expect(finished?.status).toBe("completed");
      expect(finished?.error).toBeNull();
      const history = services.manager.history(spawned.task.task_id, { limit: 100 });
      expect(history.events.map((event) => event.event_type)).not.toContain(
        "task.scope_violation",
      );
    } finally {
      await services.manager.shutdown();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("reuses a completed task's managed worktree for a new read-only session", async () => {
    const dir = await realpath(await makeTempDir());
    const services = createServices(config(dir), new WritingAdapter(), createLogger("silent"));
    try {
      const repo = await makeGitRepo(dir);
      const first = await services.manager.spawn({
        task: "Create the managed workspace.",
        repo_root: repo,
        task_type: "coding",
        model: "mock/echo",
        read_only: false,
        timeout_seconds: 10,
      });
      const completed = await services.manager.waitForTerminal(first.task.task_id, 5000);
      expect(completed?.status).toBe("completed");
      expect(completed?.worktree_path).not.toBeNull();

      const preflight = await services.service.preflight({
        repo_root: repo,
        read_only: true,
        workspace_from_task_id: first.task.task_id,
      });
      expect(preflight.workspace.kind).toBe("managed_workspace");
      expect(preflight.workspace.path).toBe(completed?.worktree_path);

      const second = await services.manager.spawn({
        task: "Review the managed workspace without editing it.",
        repo_root: repo,
        task_type: "analysis",
        model: "mock/echo",
        read_only: true,
        timeout_seconds: 10,
        workspace_from_task_id: first.task.task_id,
      });
      const reviewed = await services.manager.waitForTerminal(second.task.task_id, 5000);
      expect(reviewed?.status).toBe("completed");
      expect(reviewed?.workspace_path).toBe(completed?.worktree_path);
      expect(reviewed?.repo_root).toBe(repo);
    } finally {
      await services.manager.shutdown();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
