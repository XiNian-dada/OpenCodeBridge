import { realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createLogger } from "../../src/logging.js";
import { READ_ONLY_PERMISSIONS } from "../../src/opencode/adapter.js";
import { startManagedOpenCodeServer } from "../../src/opencode/process.js";
import { makeTempDir } from "../helpers/fixtures.js";

const live = process.env.OPENCODE_LIVE === "1";

describe.skipIf(!live)("live OpenCode 2.1 API smoke", () => {
  it("starts a private server, creates a session, and admits a no-reply prompt", async () => {
    const dir = await realpath(await makeTempDir());
    let managed;
    try {
      managed = await startManagedOpenCodeServer({
        binary: process.env.OPENCODE_BIN ?? "/opt/homebrew/bin/opencode",
        cwd: dir,
        dataDir: join(dir, "data"),
        taskId: "task_live_smoke",
        configContent: { permissions: [...READ_ONLY_PERMISSIONS], snapshots: false },
        compatibility: "2.1.x",
        startupTimeoutMs: 15000,
        logger: createLogger("silent"),
        sandbox: { worktreePath: dir },
      });

      expect(managed.info.version).toMatch(/^2\.1\./);
      expect(managed.sandboxed).toBe(true);
      const models = await managed.client.models();
      const free = models.find(
        (model) =>
          Array.isArray(model.cost) &&
          model.cost.length > 0 &&
          model.cost.every((entry) => entry.input === 0 && entry.output === 0),
      );
      expect(free).toBeDefined();
      if (free === undefined) return;

      const session = await managed.client.createSession({
        title: "bridge live smoke",
        model: { providerID: free.providerID, id: free.id },
      });
      expect(session.id).toMatch(/^ses_/);

      await managed.client.prompt(session.id, {
        text: "API smoke only; do not invoke a model.",
        resume: false,
      });
      expect(await managed.client.interrupt(session.id)).toBe(false);

      const controller = new AbortController();
      const stream = managed.client.events(controller.signal);
      const first = await stream.next();
      expect(first.done).toBe(false);
      expect(first.value?.type).toBe("server.connected");
      controller.abort();
    } finally {
      if (managed !== undefined) await managed.stop();
      await rm(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
