import { realpath, rm, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createServices } from "../../src/app.js";
import type { BridgeConfig } from "../../src/config.js";
import { createLogger } from "../../src/logging.js";
import { OpenCodeAdapter } from "../../src/opencode/adapter.js";
import { OpenCodeHttpClient } from "../../src/opencode/http-client.js";
import type { ManagedOpenCodeServer, ManagedOpenCodeServerOptions } from "../../src/opencode/process.js";
import { makeTempDir } from "../helpers/fixtures.js";
import { startFakeOpenCode, type FakeScenario } from "../helpers/fake-opencode.js";
import { sandboxAvailable } from "../../src/security/sandbox.js";
import { makeGitRepo } from "../helpers/fixtures.js";

async function makeOpenCodeHarness(scenario: FakeScenario) {
  const tempDir = await realpath(await makeTempDir());
  const fake = await startFakeOpenCode(scenario);
  const config: BridgeConfig = {
    adapter: "opencode",
    log_level: "silent",
    data_dir: join(tempDir, "data"),
    scheduler: {
      max_concurrent: 2,
      max_queue: 5,
      default_timeout_seconds: 10,
      max_timeout_seconds: 30,
    },
    models: {
      default: "fake/echo",
      allow: ["fake/echo"],
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

  const client = new OpenCodeHttpClient({ baseUrl: fake.baseUrl, password: fake.password });
  let stops = 0;
  let lastServerOptions: ManagedOpenCodeServerOptions | null = null;
  const server: ManagedOpenCodeServer = {
    client,
    info: { version: "2.1.2", pid: 1234, urls: [fake.baseUrl], paths: { tmp: "/tmp" } },
    pid: 1234,
    port: 1234,
    logPath: join(tempDir, "fake-opencode.log"),
    sandboxed: false,
    async stop() {
      stops++;
    },
  };

  const adapter = new OpenCodeAdapter({
    config,
    logger: createLogger("silent"),
    serverStarter: async (options) => {
      lastServerOptions = options;
      return server;
    },
  });
  const services = createServices(config, adapter, createLogger("silent"));

  return {
    tempDir,
    fake,
    config,
    services,
    server,
    stopCount: () => stops,
    lastServerOptions: () => lastServerOptions,
    async cleanup() {
      await services.manager.shutdown();
      await fake.close();
      await rm(tempDir, { recursive: true, force: true });
    },
  };
}

function input(repoRoot: string) {
  return {
    task: "Inspect the parser and summarize its behavior.",
    repo_root: repoRoot,
    task_type: "analysis" as const,
    model: "fake/echo",
    read_only: true,
    timeout_seconds: 10,
  };
}

describe("OpenCodeAdapter", () => {
  it("runs a read-only session, records tool events, and stops its server", async () => {
    const harness = await makeOpenCodeHarness("success");
    try {
      const spawned = await harness.services.manager.spawn(input(harness.tempDir));
      const finished = await harness.services.manager.waitForTerminal(spawned.task.task_id, 5000);

      expect(finished?.status).toBe("completed");
      expect(finished?.session_id).toMatch(/^ses_/);
      expect(finished?.usage.input_tokens).toBe(10);
      expect(finished?.usage.output_tokens).toBe(5);
      expect(finished?.estimated_cost_usd).toBe(0.003);
      expect(finished?.cost_known).toBe(true);

      const history = harness.services.manager.history(spawned.task.task_id, { limit: 100 });
      const types = history.events.map((event) => event.event_type);
      expect(types).toContain("opencode.server.started");
      expect(types).toContain("opencode.model.resolved");
      expect(types).toContain("tool.called");
      expect(types).toContain("opencode.message");
      expect(types).toContain("task.completed");
      expect(harness.stopCount()).toBeGreaterThan(0);
    } finally {
      await harness.cleanup();
    }
  });

  it("creates a worktree for writable tasks when a sandbox is available", async () => {
    const harness = await makeOpenCodeHarness("success");
    try {
      if (!sandboxAvailable()) {
        await expect(
          harness.services.manager.spawn({ ...input(harness.tempDir), read_only: false }),
        ).rejects.toMatchObject({ code: "SANDBOX_UNAVAILABLE" });
        return;
      }

      const repo = await makeGitRepo(harness.tempDir, "writable-repo");
      const spawned = await harness.services.manager.spawn({
        ...input(repo),
        read_only: false,
      });
      const finished = await harness.services.manager.waitForTerminal(spawned.task.task_id, 5000);
      expect(finished?.status).toBe("completed");
      expect(finished?.worktree_path).not.toBeNull();
      expect(finished?.worktree_path).not.toBe(repo);
    } finally {
      await harness.cleanup();
    }
  });


  it("injects scoped edit permissions for write_paths", async () => {
    const harness = await makeOpenCodeHarness("success");
    try {
      if (!sandboxAvailable()) return;
      const repo = await makeGitRepo(harness.tempDir, "scoped-repo");
      const spawned = await harness.services.manager.spawn({
        ...input(repo),
        read_only: false,
        write_paths: ["allowed.txt"],
      });
      const finished = await harness.services.manager.waitForTerminal(spawned.task.task_id, 5000);
      expect(finished?.status).toBe("completed");
      const permissions = harness.lastServerOptions()?.configContent.permissions as Array<{
        action: string;
        resource: string;
        effect: string;
      }>;
      expect(permissions).toEqual(
        expect.arrayContaining([
          { action: "edit", resource: "allowed.txt", effect: "allow" },
          { action: "edit", resource: join(finished!.worktree_path!, "allowed.txt"), effect: "allow" },
          { action: "edit", resource: "*", effect: "deny" },
        ]),
      );
    } finally {
      await harness.cleanup();
    }
  });

  it("resumes the same OpenCode session for a follow-up message", async () => {
    const harness = await makeOpenCodeHarness("success");
    try {
      const first = await harness.services.manager.spawn(input(harness.tempDir));
      const completed = await harness.services.manager.waitForTerminal(first.task.task_id, 5000);
      expect(completed?.session_id).not.toBeNull();
      expect(completed?.result_summary).toBe("Fake task completed turn 1");

      const followUp = await harness.services.manager.message(
        first.task.task_id,
        "Please continue with one more check.",
      );
      expect(followUp.task.parent_task_id).toBe(first.task.task_id);
      expect(followUp.task.session_id).toBe(completed?.session_id);

      const child = await harness.services.manager.waitForTerminal(followUp.task.task_id, 5000);
      expect(child?.status).toBe("completed");
      expect(child?.session_id).toBe(completed?.session_id);
      expect(child?.result_summary).toBe("Fake task completed turn 2");
      expect(child?.usage.total_tokens).toBe(15);
      expect(child?.usage.input_tokens).toBe(10);
      expect(child?.usage.output_tokens).toBe(5);
      expect(child?.estimated_cost_usd).toBeCloseTo(0.003, 6);

      const history = harness.services.manager.history(followUp.task.task_id, { limit: 100 });
      const types = history.events.map((event) => event.event_type);
      expect(types).toContain("task.resumed");
      expect(types).toContain("opencode.session.resumed");
      const replies = history.events.filter((event) => event.event_type === "opencode.message" && event.payload.role === "assistant");
      expect(replies.map((event) => event.payload.text)).toEqual([
        "Fake task completed turn 2",
      ]);
    } finally {
      await harness.cleanup();
    }
  });

  it("does not complete a follow-up from the previous turn's answer or idle state", async () => {
    const harness = await makeOpenCodeHarness("followup-delay");
    try {
      const first = await harness.services.manager.spawn(input(harness.tempDir));
      const completed = await harness.services.manager.waitForTerminal(first.task.task_id, 5000);
      expect(completed?.status).toBe("completed");
      expect(completed?.result_summary).toBe("Fake task completed turn 1");

      const followUp = await harness.services.manager.message(
        first.task.task_id,
        "Please continue with one more check.",
      );

      await new Promise((resolve) => setTimeout(resolve, 120));
      const duringInbox = harness.services.manager.status(followUp.task.task_id);
      expect(duringInbox.status).not.toBe("completed");
      expect(duringInbox.error).toBeNull();

      const child = await harness.services.manager.waitForTerminal(followUp.task.task_id, 5000);
      expect(child?.status).toBe("completed");
      expect(child?.result_summary).toBe("Fake task completed turn 2");
      expect(child?.usage.total_tokens).toBe(15);
      expect(child?.usage.input_tokens).toBe(10);
      expect(child?.usage.output_tokens).toBe(5);

      const replies = harness.services.manager
        .history(followUp.task.task_id, { limit: 100 })
        .events.filter(
          (event) =>
            event.event_type === "opencode.message" &&
            event.payload.role === "assistant",
        );
      expect(replies.map((event) => event.payload.text)).toEqual([
        "Fake task completed turn 2",
      ]);
    } finally {
      await harness.cleanup();
    }
  });

  it("keeps a stable authorized directory when a follow-up adds context", async () => {
    const h = await makeOpenCodeHarness("success");
    try {
      await writeFile(join(h.tempDir, "first.txt"), "first");
      await writeFile(join(h.tempDir, "next.txt"), "next");
      const first = await h.services.manager.spawn({ ...input(h.tempDir), context_files: ["first.txt"] });
      const initial = await h.services.manager.waitForTerminal(first.task.task_id, 5000);
      await writeFile(join(h.tempDir, "first.txt"), "changed in main repo");
      const follow = await h.services.manager.message(first.task.task_id, "Read next.txt", ["next.txt"]);
      const done = await h.services.manager.waitForTerminal(follow.task.task_id, 5000);
      expect(done?.status).toBe("completed");
      expect(done?.session_id).toBe(initial?.session_id);
      expect(done?.context_path).toBe(initial?.context_path);
      expect(await readFile(join(done!.context_path!, "next.txt"), "utf8")).toBe("next");
      expect(await readFile(join(done!.context_path!, "first.txt"), "utf8")).toBe("first");
      const original = await h.services.service.delivery({ task_id: initial!.task_id });
      const next = await h.services.service.delivery({ task_id: done!.task_id });
      expect(original.context.files).toHaveLength(1);
      expect(next.context.files).toHaveLength(2);
      expect(original.context.manifest_path).not.toBe(next.context.manifest_path);
    } finally { await h.cleanup(); }
  });

  it("aborts a running OpenCode session", async () => {
    const harness = await makeOpenCodeHarness("abort");
    try {
      const spawned = await harness.services.manager.spawn(input(harness.tempDir));
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline && harness.services.manager.status(spawned.task.task_id).status !== "running") {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(harness.services.manager.status(spawned.task.task_id).status).toBe("running");

      const aborted = await harness.services.manager.abort(spawned.task.task_id);
      expect(aborted.stopped).toBe(true);
      expect(aborted.task.status).toBe("cancelled");
    } finally {
      await harness.cleanup();
    }
  });

  it("records a completed final step over budget without issuing a pointless abort", async () => {
    const harness = await makeOpenCodeHarness("success");
    try {
      harness.config.models.max_tokens = 10;
      const spawned = await harness.services.manager.spawn(input(harness.tempDir));
      const finished = await harness.services.manager.waitForTerminal(spawned.task.task_id, 5000);
      expect(finished?.status).toBe("failed");
      expect(finished?.error?.code).toBe("BUDGET_EXCEEDED");
      expect(finished?.result_summary).toBe("Fake task completed turn 1");
      const events = harness.services.manager.history(spawned.task.task_id, { limit: 200 }).events;
      const types = events.map((event) => event.event_type);
      expect(types).toContain("task.budget.threshold");
      expect(types).toContain("task.budget_exceeded");
      expect(types).not.toContain("task.cancelling");
      expect(types).toContain("task.failed");

      harness.config.models.max_tokens = 1_000_000;
      const delivery = await harness.services.service.delivery({
        task_id: spawned.task.task_id,
      });
      expect(delivery.budget).toMatchObject({
        max_tokens: 10,
        exceeded: true,
        scope: "turn",
      });
      expect(delivery.runtime.opencode_version).toBe("2.1.2");
    } finally {
      await harness.cleanup();
    }
  });

  it("maps session errors to a failed task", async () => {
    const harness = await makeOpenCodeHarness("error");
    try {
      const spawned = await harness.services.manager.spawn(input(harness.tempDir));
      const finished = await harness.services.manager.waitForTerminal(spawned.task.task_id, 5000);
      expect(finished?.status).toBe("failed");
      expect(finished?.error?.code).toBe("ADAPTER_ERROR");
    } finally {
      await harness.cleanup();
    }
  });
});
