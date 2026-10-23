import { stat } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { IpcTaskClient } from "../../src/daemon/client.js";
import { IpcServer } from "../../src/daemon/server.js";
import { createLogger } from "../../src/logging.js";
import { createHarness, spawnInput } from "../helpers/fixtures.js";

describe("daemon IPC", () => {
  it("serves task operations over a private Unix socket", async () => {
    const harness = await createHarness();
    const socketPath = join(harness.tempDir, "bridge.sock");
    const server = new IpcServer({
      socketPath,
      service: harness.services.service,
      logger: createLogger("silent"),
    });
    let client: IpcTaskClient | null = null;
    try {
      await server.listen();
      expect((await stat(socketPath)).mode & 0o777).toBe(0o600);

      client = await IpcTaskClient.connect(socketPath);
      const spawned = await client.spawn({
        ...spawnInput(harness.repoRoot),
        read_only: true,
      });
      expect(spawned.task.status).toMatch(/queued|preparing|running/);

      const completed = await waitForStatus(client, spawned.task.task_id, "completed");
      expect(completed.session_id).toMatch(/^mock_sess_/);

      const history = await client.history(spawned.task.task_id, { limit: 50 });
      expect(history.events.map((event) => event.event_type)).toContain("task.completed");

      const listed = await client.list({ limit: 10 });
      expect(listed.some((task) => task.task_id === spawned.task.task_id)).toBe(true);

      const diff = await client.diff(spawned.task.task_id);
      expect(diff.available).toBe(false);

      await expect(client.status("task_missing")).rejects.toMatchObject({
        code: "TASK_NOT_FOUND",
      });
    } finally {
      client?.close();
      await server.close();
      await harness.cleanup();
    }
  });
});

async function waitForStatus(
  client: IpcTaskClient,
  taskId: string,
  status: string,
  timeoutMs = 5000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const view = await client.status(taskId);
    if (view.status === status) return view;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${status}`);
}
