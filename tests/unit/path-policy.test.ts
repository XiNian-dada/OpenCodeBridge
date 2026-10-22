import { mkdir, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PathPolicy } from "../../src/policy/path-policy.js";
import { makeGitRepo, makeTempDir } from "../helpers/fixtures.js";

const cleanupDirs: string[] = [];

afterEach(async () => {
  await Promise.all(cleanupDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("PathPolicy", () => {
  it("resolves a writable Git repo and records its base commit", async () => {
    const root = await makeTempDir();
    cleanupDirs.push(root);
    const repo = await makeGitRepo(root);
    const policy = new PathPolicy([await realpath(root)], true);

    const resolved = await policy.resolveRepoRoot(repo, false);
    expect(resolved.repo_root).toBe(repo);
    expect(resolved.git_top_level).toBe(repo);
    expect(resolved.base_commit).toMatch(/^[0-9a-f]{40}$/);
  });

  it("accepts read-only directories without Git", async () => {
    const root = await makeTempDir();
    cleanupDirs.push(root);
    const policy = new PathPolicy([await realpath(root)], true);
    const resolved = await policy.resolveRepoRoot(root, true);
    expect(resolved.repo_root).toBe(await realpath(root));
    expect(resolved.git_top_level).toBeNull();
  });

  it("rejects paths outside allowed roots", async () => {
    const allowed = await makeTempDir();
    const outside = await makeTempDir();
    cleanupDirs.push(allowed, outside);
    const repo = await makeGitRepo(outside);
    const policy = new PathPolicy([await realpath(allowed)], true);

    await expect(policy.resolveRepoRoot(repo, false)).rejects.toMatchObject({
      code: "REPO_NOT_ALLOWED",
    });
  });

  it("rejects writable non-Git directories", async () => {
    const root = await makeTempDir();
    cleanupDirs.push(root);
    const plain = join(root, "plain");
    await mkdir(plain);
    const policy = new PathPolicy([await realpath(root)], true);

    await expect(policy.resolveRepoRoot(plain, false)).rejects.toMatchObject({
      code: "REPO_NOT_GIT",
    });
  });

  it("rejects relative and missing paths", async () => {
    const policy = new PathPolicy(["/tmp"], true);
    await expect(policy.resolveRepoRoot("relative/path", true)).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
    await expect(policy.resolveRepoRoot("/definitely/not/here", true)).rejects.toMatchObject({
      code: "REPO_NOT_FOUND",
    });
  });

  it("fails closed when an allowed root does not exist", async () => {
    const policy = new PathPolicy(["/definitely/not/an/allowed/root"], true);
    await expect(policy.resolveRepoRoot("/tmp", true)).rejects.toMatchObject({
      code: "INVALID_CONFIG",
    });
  });
});
