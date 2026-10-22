import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createLogger } from "../../src/logging.js";
import { startManagedOpenCodeServer } from "../../src/opencode/process.js";

const fakeBinary = `#!/usr/bin/env node
import { createServer } from "node:http";
const args = process.argv.slice(2);
const port = Number(args[args.indexOf("--port") + 1]);
const version = process.env.FAKE_VERSION ?? "2.1.2";
const server = createServer((req, res) => {
  if (req.url === "/api/info") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ version, pid: process.pid, urls: ["http://127.0.0.1:" + port], paths: { tmp: "/tmp" } }));
    return;
  }
  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ message: "not found" }));
});
server.listen(port, "127.0.0.1");
const stop = () => server.close(() => process.exit(0));
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
`;

async function makeFakeBinary(): Promise<{ dir: string; binary: string }> {
  const dir = await mkdtemp(join(tmpdir(), "cob-fake-opencode-"));
  const binary = join(dir, "opencode");
  await writeFile(binary, fakeBinary, "utf8");
  await chmod(binary, 0o755);
  return { dir, binary };
}

describe("managed OpenCode process", () => {
  it("starts a private server, checks its version, and stops the process group", async () => {
    const { dir, binary } = await makeFakeBinary();
    let managed;
    try {
      managed = await startManagedOpenCodeServer({
        binary,
        cwd: dir,
        dataDir: join(dir, "data"),
        taskId: "task_process_test",
        configContent: {},
        compatibility: "2.1.x",
        startupTimeoutMs: 5000,
        logger: createLogger("silent"),
      });

      expect(managed.info.version).toBe("2.1.2");
      expect(managed.port).toBeGreaterThan(0);
      const info = await managed.client.info();
      expect(info.pid).toBeGreaterThan(0);
      expect(managed.logPath).toContain("opencode-task_process_test.log");

      const pid = managed.pid;
      await managed.stop();
      expect(() => process.kill(pid, 0)).toThrow();
    } finally {
      if (managed !== undefined) await managed.stop();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects an incompatible OpenCode version and cleans up", async () => {
    const { dir, binary } = await makeFakeBinary();
    try {
      await expect(
        startManagedOpenCodeServer({
          binary,
          cwd: dir,
          dataDir: join(dir, "data"),
          taskId: "task_incompatible",
          configContent: {},
          compatibility: "2.1.x",
          startupTimeoutMs: 5000,
          logger: createLogger("silent"),
          extraEnv: { FAKE_VERSION: "9.9.9" },
        }),
      ).rejects.toMatchObject({ code: "OPENCODE_INCOMPATIBLE" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
