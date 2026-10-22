import { execFile } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { BridgeError } from "../errors.js";

const execFileAsync = promisify(execFile);

export interface ResolvedRepo {
  repo_root: string;
  git_top_level: string | null;
  base_commit: string | null;
}

export class PathPolicy {
  private allowedRoots: string[] | null = null;

  constructor(
    private readonly rawAllowedRoots: string[],
    private readonly requireGitForWrites: boolean,
  ) {}

  async resolveRepoRoot(input: string, readOnly: boolean): Promise<ResolvedRepo> {
    if (!isAbsolute(input)) {
      throw new BridgeError("INVALID_ARGUMENT", `repo_root must be absolute: ${input}`);
    }

    let realPath: string;
    try {
      realPath = await realpath(input);
    } catch (error) {
      throw new BridgeError("REPO_NOT_FOUND", `Repository path does not exist: ${input}`, {
        cause: error,
      });
    }

    const info = await stat(realPath);
    if (!info.isDirectory()) {
      throw new BridgeError("REPO_NOT_FOUND", `Repository path is not a directory: ${input}`);
    }

    if (!(await this.isAllowed(realPath))) {
      throw new BridgeError("REPO_NOT_ALLOWED", `Repository path is outside the allowed roots: ${realPath}`, {
        details: { allowed_roots: this.rawAllowedRoots },
      });
    }

    if (readOnly) {
      return { repo_root: realPath, git_top_level: null, base_commit: null };
    }

    const topLevel = await this.gitTopLevel(realPath);
    if (topLevel === null) {
      throw new BridgeError(
        "REPO_NOT_GIT",
        this.requireGitForWrites
          ? `Writable tasks require a Git repository: ${realPath}`
          : `This write mode requires a Git repository: ${realPath}`,
        { details: { repo_root: realPath } },
      );
    }

    if (!(await this.isAllowed(topLevel))) {
      throw new BridgeError(
        "REPO_NOT_ALLOWED",
        `Git top-level is outside the allowed roots: ${topLevel}`,
        { details: { top_level: topLevel } },
      );
    }

    return {
      repo_root: topLevel,
      git_top_level: topLevel,
      base_commit: await this.gitHead(topLevel),
    };
  }

  async isAllowed(candidate: string): Promise<boolean> {
    const roots = await this.getAllowedRoots();
    const normalizedCandidate = this.normalize(candidate);
    return roots.some((root) => {
      const normalizedRoot = this.normalize(root);
      return (
        normalizedCandidate === normalizedRoot ||
        normalizedCandidate.startsWith(`${normalizedRoot}${sep}`)
      );
    });
  }

  private normalize(input: string): string {
    const resolved = resolve(input);
    return process.platform === "darwin" || process.platform === "win32"
      ? resolved.toLowerCase()
      : resolved;
  }

  private async getAllowedRoots(): Promise<string[]> {
    if (this.allowedRoots !== null) return this.allowedRoots;

    const resolvedRoots: string[] = [];
    for (const root of this.rawAllowedRoots) {
      try {
        resolvedRoots.push(await realpath(root));
      } catch (error) {
        throw new BridgeError("INVALID_CONFIG", `Allowed repository root does not exist: ${root}`, {
          cause: error,
        });
      }
    }
    this.allowedRoots = resolvedRoots;
    return resolvedRoots;
  }

  private async gitTopLevel(directory: string): Promise<string | null> {
    try {
      const { stdout } = await execFileAsync("git", ["-C", directory, "rev-parse", "--show-toplevel"], {
        timeout: 5000,
        maxBuffer: 1024 * 1024,
      });
      const value = stdout.trim();
      return value === "" ? null : realpath(value);
    } catch {
      return null;
    }
  }

  private async gitHead(directory: string): Promise<string | null> {
    try {
      const { stdout } = await execFileAsync("git", ["-C", directory, "rev-parse", "HEAD"], {
        timeout: 5000,
        maxBuffer: 1024 * 1024,
      });
      const value = stdout.trim();
      return value === "" ? null : value;
    } catch {
      return null;
    }
  }
}
