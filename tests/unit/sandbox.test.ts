import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  buildReadSeatbeltProfile,
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

  it("builds a read profile that hides the home directory and external mounts", () => {
    const profile = buildReadSeatbeltProfile({
      taskDir: "/private/tmp/task",
      tempDir: "/private/tmp/task/tmp",
      worktreePath: "/Users/example/worktree",
    });
    expect(profile).toContain('(deny file-read-data (subpath "/Users"))');
    expect(profile).toContain('(deny file-read-data (subpath "/Volumes"))');
    expect(profile).toContain('(deny file-read-data (subpath "/private/var/folders"))');
    expect(profile).toContain('(subpath "/Users/example/worktree")');
    expect(profile).toContain("(allow network*)");

    const isolatedWrite = buildSeatbeltProfile({
      taskDir: "/private/tmp/task",
      tempDir: "/private/tmp/task/tmp",
      worktreePath: "/Users/example/worktree",
      gitDir: "/Users/example/repo/.git/worktrees/task",
      isolateConfig: true,
      gatewayPort: 4321,
    });
    expect(isolatedWrite).toContain('(deny file-read-data (subpath "/Users"))');
    expect(isolatedWrite).toContain('(subpath "/Users/example/worktree")');
    expect(isolatedWrite).toContain('(subpath "/Users/example/repo/.git/worktrees/task")');
    expect(isolatedWrite).toContain('(allow network-outbound (remote ip "localhost:4321"))');
    expect(isolatedWrite).not.toContain("(allow network*)");
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

  it.skipIf(!sandboxAvailable())("denies reads outside the workspace and writes inside it in read mode", async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), "cob-sandbox-read-")));
    try {
      const taskDir = join(dir, "task");
      const workspace = join(dir, "workspace");
      const denied = join(dir, "denied");
      await mkdir(taskDir);
      await mkdir(workspace);
      await mkdir(denied);
      await writeFile(join(workspace, "allowed.txt"), "allowed\n", "utf8");
      await writeFile(join(denied, "secret.txt"), "secret\n", "utf8");

      const profile = await writeSeatbeltProfile({
        mode: "read",
        taskDir,
        tempDir: join(taskDir, "tmp"),
        worktreePath: workspace,
      });

      const allowed = await execFileAsync("/usr/bin/sandbox-exec", [
        "-f",
        profile,
        "/bin/cat",
        join(workspace, "allowed.txt"),
      ]);
      expect(allowed.stdout).toBe("allowed\n");

      await expect(
        execFileAsync("/usr/bin/sandbox-exec", [
          "-f",
          profile,
          "/bin/cat",
          join(denied, "secret.txt"),
        ]),
      ).rejects.toBeTruthy();

      await expect(
        execFileAsync("/usr/bin/sandbox-exec", [
          "-f",
          profile,
          "/bin/sh",
          "-c",
          `echo no > '${workspace}/no.txt'`,
        ]),
      ).rejects.toBeTruthy();
      await expect(readFile(join(workspace, "no.txt"), "utf8")).rejects.toBeTruthy();

      await execFileAsync("/usr/bin/sandbox-exec", [
        "-f",
        profile,
        "/bin/sh",
        "-c",
        `echo ok > '${taskDir}/ok.txt'`,
      ]);
      expect(await readFile(join(taskDir, "ok.txt"), "utf8")).toBe("ok\n");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it.skipIf(!sandboxAvailable())("allows only the configured gateway port on the network", async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), "cob-sandbox-net-")));
    const allowed = createServer((_req, res) => res.end("allowed"));
    const denied = createServer((_req, res) => res.end("denied"));
    try {
      await new Promise<void>((resolve) => allowed.listen(0, "127.0.0.1", resolve));
      await new Promise<void>((resolve) => denied.listen(0, "127.0.0.1", resolve));
      const allowedAddress = allowed.address();
      const deniedAddress = denied.address();
      if (
        allowedAddress === null ||
        typeof allowedAddress === "string" ||
        deniedAddress === null ||
        typeof deniedAddress === "string"
      ) {
        throw new Error("failed to bind test servers");
      }

      const taskDir = join(dir, "task");
      const workspace = join(dir, "workspace");
      await mkdir(taskDir);
      await mkdir(workspace);
      const profile = await writeSeatbeltProfile({
        mode: "read",
        taskDir,
        tempDir: join(taskDir, "tmp"),
        worktreePath: workspace,
        gatewayPort: allowedAddress.port,
        isolateConfig: true,
      });

      const ok = await execFileAsync("/usr/bin/sandbox-exec", [
        "-f",
        profile,
        "/usr/bin/curl",
        "-s",
        "-m",
        "2",
        `http://127.0.0.1:${allowedAddress.port}/`,
      ]);
      expect(ok.stdout).toBe("allowed");

      await expect(
        execFileAsync("/usr/bin/sandbox-exec", [
          "-f",
          profile,
          "/usr/bin/curl",
          "-s",
          "-m",
          "2",
          `http://127.0.0.1:${deniedAddress.port}/`,
        ]),
      ).rejects.toBeTruthy();
    } finally {
      await new Promise<void>((resolve) => allowed.close(() => resolve()));
      await new Promise<void>((resolve) => denied.close(() => resolve()));
      await rm(dir, { recursive: true, force: true });
    }
  });
});
