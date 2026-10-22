import { execFile } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  buildSeatbeltProfile,
  sandboxAvailable,
  writeSeatbeltProfile,
} from "../../src/security/sandbox.js";

const execFileAsync = promisify(execFile);

describe("macOS sandbox profile", () => {
  it("includes task, temp, and worktree write boundaries", () => {
    const profile = buildSeatbeltProfile({
      taskDir: "/private/tmp/task",
      tempDir: "/private/tmp/task/tmp",
      worktreePath: "/Users/example/worktree",
    });
    expect(profile).toContain('(subpath "/private/tmp/task")');
    expect(profile).toContain('(subpath "/Users/example/worktree")');
    expect(profile).toContain('(literal "/dev/null")');
    expect(profile).toContain("(allow network*)");
  });

  it.skipIf(!sandboxAvailable())("permits writes only inside allowed paths", async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), "cob-sandbox-test-")));
    try {
      const meta = join(dir, "meta");
      const allowed = join(dir, "allowed");
      const denied = join(dir, "denied");
      await execFileAsync("mkdir", ["-p", meta, allowed, denied]);
      const profile = await writeSeatbeltProfile({
        taskDir: meta,
        tempDir: join(meta, "tmp"),
        worktreePath: allowed,
      });

      await expect(
        execFileAsync("/usr/bin/sandbox-exec", [
          "-f",
          profile,
          "/bin/sh",
          "-c",
          `echo ok > '${allowed}/ok.txt'; echo no > '${denied}/no.txt'`,
        ]),
      ).rejects.toBeTruthy();

      expect(await readFile(join(allowed, "ok.txt"), "utf8")).toBe("ok\n");
      await expect(readFile(join(denied, "no.txt"), "utf8")).rejects.toBeTruthy();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
