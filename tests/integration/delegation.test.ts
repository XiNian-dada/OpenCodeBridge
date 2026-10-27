import { describe, expect, it } from "vitest";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHarness, spawnInput } from "../helpers/fixtures.js";

describe("delegation discovery and waiting", () => {
  it("reports policy and soft limits without probing or invoking the adapter", async () => {
    const h = await createHarness({ maxTokens: 1000 });
    try {
      h.config.models.allow.push("mock/premium", "opencode-go/*");
      h.config.models.expensive.push("mock/premium");
      h.adapter.probe = async () => { throw new Error("must not probe"); };
      h.adapter.start = async () => { throw new Error("must not run"); };
      const capabilities = await h.services.service.capabilities();
      expect(capabilities.simulated).toBe(true);
      expect(capabilities.models.allowed).toEqual([
        { model: "mock/echo", permitted: true, error_code: null },
        { model: "mock/premium", permitted: false, error_code: "MODEL_UPGRADE_REQUIRED" },
        { model: "opencode-go/*", permitted: true, error_code: null },
      ]);
      expect(capabilities.models.availability).toBe("validated_at_task_start");
      expect(capabilities.build).toMatchObject({
        version: "0.1.0",
        config_path: h.configPath,
      });
      expect(capabilities.build.config_revision).toMatch(/^[0-9a-f]{16}$/);
      expect(capabilities.budgets).toMatchObject({ max_tokens: 1000, enforcement: "soft" });
      expect(capabilities.execution.write_isolation).toBe("simulated");
      expect(h.services.manager.list({ limit: 10 })).toEqual([]);
    } finally { await h.cleanup(); }
  });

  it("preflights path, model, workspace and permissions without creating a task", async () => {
    const h = await createHarness();
    try {
      const result = await h.services.service.preflight({
        repo_root: h.repoRoot,
        read_only: true,
      });
      expect(result.workspace.kind).toBe("repo_root");
      expect(result.workspace.path).toBe(h.repoRoot);
      expect(result.workspace.git_top_level).not.toBeNull();
      expect(result.workspace.base_commit).toMatch(/^[0-9a-f]{40}$/);
      expect(result.model).toMatchObject({
        model: "mock/echo",
        permitted: true,
        availability: "unverified_until_start",
      });
      expect(result.permissions).toMatchObject({
        read: true,
        glob: true,
        grep: true,
        edit: false,
        write: false,
        shell: false,
        web: false,
        subagent: false,
      });
      expect(result.isolation.write_isolation).toBe("simulated");
      expect(result.budgets.hard_limits).toContain("task_timeout");
      expect(result.unverified.length).toBeGreaterThan(0);
      expect(h.services.manager.list({ limit: 10 })).toEqual([]);

      await expect(
        h.services.service.preflight({ repo_root: "/", read_only: true }),
      ).rejects.toMatchObject({ code: "REPO_NOT_ALLOWED" });
      await expect(
        h.services.service.preflight({
          repo_root: h.repoRoot,
          read_only: true,
          model: "forbidden/model",
        }),
      ).rejects.toMatchObject({ code: "MODEL_NOT_ALLOWED" });
    } finally { await h.cleanup(); }
  });

  it("returns a delivery package with simulated commands and explicit verification gaps", async () => {
    const h = await createHarness();
    try {
      const { task } = await h.services.service.spawn({
        ...spawnInput(h.repoRoot),
        read_only: true,
      });
      await h.services.manager.waitForTerminal(task.task_id, 5000);
      const delivery = await h.services.service.delivery({ task_id: task.task_id });
      expect(delivery.status).toBe("completed");
      expect(delivery.git).toMatchObject({ available: false, reason: "no_worktree" });
      expect(delivery.model.simulated).toBe(true);
      expect(delivery.model.verified).toBe(false);
      expect(delivery.commands.length).toBeGreaterThan(0);
      expect(delivery.commands[0]).toMatchObject({
        source: "simulated",
        verified_by_bridge: false,
      });
      expect(delivery.verification.status).toBe("simulated");
      expect(delivery.verification.tests_run_by_bridge).toBe(false);
      expect(delivery.policy_snapshot).toMatchObject({
        config_revision: h.config.config_revision,
        max_tokens: null,
      });
      expect(delivery.runtime).toMatchObject({
        bridge_version: "0.1.0",
        config_revision: h.config.config_revision,
      });
      expect(delivery.unverified.length).toBeGreaterThan(0);
    } finally { await h.cleanup(); }
  });

  it("reports caller-controlled duration when no default timeout is configured", async () => {
    const h = await createHarness({ defaultTimeoutSeconds: 0 });
    try {
      const result = await h.services.service.preflight({
        repo_root: h.repoRoot,
        read_only: true,
      });
      expect(result.timeout_seconds).toEqual({
        default: 0,
        max: 60,
        automatic_timeout: false,
        zero_means: "no_automatic_timeout",
      });
      expect(result.budgets.hard_limits).not.toContain("task_timeout");

      const { task } = await h.services.service.spawn({
        ...spawnInput(h.repoRoot),
        timeout_seconds: 0,
      });
      expect(task.timeout_seconds).toBe(0);
      await h.services.manager.waitForTerminal(task.task_id, 5000);
    } finally { await h.cleanup(); }
  });

  it("builds a hashed minimal context snapshot and lets a follow-up request more files", async () => {
    const h = await createHarness();
    try {
      await writeFile(join(h.repoRoot, "extra.txt"), "extra context\n", "utf8");
      const preflight = await h.services.service.preflight({
        repo_root: h.repoRoot,
        read_only: true,
        context_files: ["README.md"],
      });
      expect(preflight.workspace.kind).toBe("context_snapshot");
      expect(preflight.context.enabled).toBe(true);
      expect(preflight.context.files).toHaveLength(1);
      expect(preflight.context.files[0]?.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(preflight.context.total_bytes).toBeGreaterThan(0);

      await expect(
        h.services.service.preflight({
          repo_root: h.repoRoot,
          read_only: true,
          context_files: ["../outside.txt"],
        }),
      ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });

      const { task } = await h.services.service.spawn({
        ...spawnInput(h.repoRoot),
        read_only: true,
        context_files: ["README.md"],
      });
      await h.services.manager.waitForTerminal(task.task_id, 5000);
      const first = await h.services.service.delivery({ task_id: task.task_id });
      expect(first.context.verified).toBe(true);
      expect(first.context.files.map((file) => file.path)).toEqual(["README.md"]);
      expect(first.context.path).not.toBeNull();

      const followUp = await h.services.service.message(
        task.task_id,
        "Use the extra context file as well.",
        ["extra.txt"],
      );
      await h.services.manager.waitForTerminal(followUp.task.task_id, 5000);
      const second = await h.services.service.delivery({ task_id: followUp.task.task_id });
      expect(second.context.verified).toBe(true);
      expect(second.context.files.map((file) => file.path).sort()).toEqual(["README.md", "extra.txt"]);
      expect(second.context.total_bytes).toBeGreaterThan(first.context.total_bytes);
    } finally { await h.cleanup(); }
  });

  it("parses structured review findings from the final assistant message", async () => {
    const h = await createHarness();
    try {
      const original = h.adapter.start.bind(h.adapter);
      h.adapter.start = async (task, prompt, context) => {
        const result = await original(task, prompt, context);
        context.emit({
          source: "opencode",
          event_type: "opencode.message",
          payload: {
            role: "assistant",
            text: "```json\n{\"findings\":[{\"location\":\"src/a.ts:12\",\"trigger\":\"empty input\",\"evidence\":\"observed throw\",\"confidence\":\"reproduced\"}]}\n```",
          },
        });
        return result;
      };
      const { task } = await h.services.service.spawn({
        ...spawnInput(h.repoRoot),
        read_only: true,
        task_type: "review",
      });
      await h.services.manager.waitForTerminal(task.task_id, 5000);
      const delivery = await h.services.service.delivery({ task_id: task.task_id });
      expect(delivery.findings.verified).toBe(true);
      expect(delivery.findings.items).toEqual([
        {
          location: "src/a.ts:12",
          trigger: "empty input",
          evidence: "observed throw",
          confidence: "reproduced",
        },
      ]);
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

  it("long-polls incremental events with an after cursor", async () => {
    const h = await createHarness({ delayMs: 100 });
    try {
      const { task } = await h.services.service.spawn(spawnInput(h.repoRoot));
      const first = await h.services.service.waitForEvents({
        task_id: task.task_id,
        after: 0,
        timeout_seconds: 5,
        limit: 100,
      });
      expect(first.timed_out).toBe(false);
      expect(first.events.length).toBeGreaterThan(0);
      expect(first.task_terminal).toBe(false);
      const cursor = first.next_after;

      await h.services.manager.waitForTerminal(task.task_id, 5000);
      const complete = await h.services.service.waitForEvents({
        task_id: task.task_id,
        after: cursor,
        timeout_seconds: 5,
        limit: 100,
      });
      expect(complete.events.length).toBeGreaterThan(0);
      expect(complete.events.every((event) => event.sequence > cursor)).toBe(true);
      expect(complete.task_terminal).toBe(true);

      const idle = await h.services.service.waitForEvents({
        task_id: task.task_id,
        after: complete.next_after,
        timeout_seconds: 1,
        limit: 100,
      });
      expect(idle).toMatchObject({ events: [], timed_out: false, task_terminal: true });
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
