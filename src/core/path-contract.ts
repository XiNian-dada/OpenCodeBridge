import { join } from "node:path";

export const DEFAULT_PROTECTED_PATHS = [
  ".git/",
  "AGENTS.md",
  ".github/",
  ".gitlab-ci.yml",
  ".circleci/",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "Cargo.lock",
  ".env",
] as const;

export interface PathContract {
  read_paths: string[];
  write_paths: string[];
  per_file_scope: boolean;
}

export function pathMatchesAllowed(file: string, allowed: readonly string[]): boolean {
  const normalized = file.replaceAll("\\", "/").replace(/^\.\//, "");
  return allowed.some((entry) => {
    if (entry.endsWith("/")) return normalized === entry.slice(0, -1) || normalized.startsWith(entry);
    return normalized === entry;
  });
}

export function isProtectedPath(file: string): boolean {
  const normalized = file.replaceAll("\\", "/").replace(/^\.\//, "");
  return DEFAULT_PROTECTED_PATHS.some((entry) => {
    if (entry.endsWith("/")) return normalized === entry.slice(0, -1) || normalized.startsWith(entry);
    return normalized === entry;
  });
}

export function scopeViolations(
  changedFiles: readonly string[],
  contract: PathContract,
): string[] {
  if (!contract.per_file_scope) return [];
  return changedFiles.filter(
    (file) =>
      !pathMatchesAllowed(file, contract.write_paths) ||
      (isProtectedPath(file) && !pathMatchesAllowed(file, contract.write_paths)),
  );
}

export function absoluteWriteResources(workspace: string, paths: readonly string[]): string[] {
  return paths.flatMap((path) => {
    if (path.endsWith("/")) {
      const base = join(workspace, path.slice(0, -1));
      return [`${path}**`, `${base}/**`];
    }
    return [path, join(workspace, path)];
  });
}
