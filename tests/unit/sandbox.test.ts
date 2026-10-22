import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  buildSeatbeltProfile,
  sandboxAvailable,
  writeSeatbeltProfile,
} from "../../src/security/sandbox.js";
import { makeGitRepo } from "../helpers/fixtures.js";

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
    expect(
      buildSeatbeltProfile({
        taskDir: "/private/tmp/task",
        tempDir: "/private/tmp/task/tmp",
        worktreePath: "/Users/example/worktree",
        gitDir: "/Users/example/repo/.git/worktrees/task",
      }),
    ).toContain('(subpath "/Users/example/repo/.git/worktrees/task")');
  });


  it.skipIf(!sandboxAvailable())("allows Git index writes for the task worktree metadata", async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), "cob-sandbox-git-")));
    try {
      const repo = await makeGitRepo(dir);
      const base = (await execFileAsync("git", ["-C", repo, "rev-parse", "HEAD"])).stdout.trim();
      const worktree = join(dir, "worktree");
      const meta = join(dir, "meta");
      await mkdir(meta);
      await execFileAsync("git", ["-C", repo, "worktree", "add", "--detach", worktree, base]);
      const gitDir = (await execFileAsync("git", ["-C", worktree, "rev-parse", "--absolute-git-dir"])).stdout.trim();
      const profile = await writeSeatbeltProfile({
        taskDir: meta,
        tempDir: join(meta, "tmp"),
        worktreePath: worktree,
        gitDir,
      });

      await expect(
        execFileAsync("/usr/bin/sandbox-exec", [
          "-f",
          profile,
          "/bin/sh",
          "-c",
          `echo new > '${worktree}/new.txt'; git -C '${worktree}' add new.txt`,
        ]),
      ).rejects.toBeTruthy();

      expect(await readFile(join(worktree, "new.txt"), "utf8")).toBe("new\n");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
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
