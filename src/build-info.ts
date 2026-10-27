import { readFileSync } from "node:fs";

export interface BuildInfo {
  version: string;
  git_sha: string | null;
  dirty: boolean | null;
  built_at: string | null;
}

const VERSION = "0.1.0";
let cached: BuildInfo | null = null;

function readBuildFile(): Partial<BuildInfo> | null {
  const candidates = [
    new URL("./build-info.json", import.meta.url),
    new URL("../dist/build-info.json", import.meta.url),
  ];
  for (const candidate of candidates) {
    try {
      return JSON.parse(readFileSync(candidate, "utf8")) as Partial<BuildInfo>;
    } catch {
      // Try the next location.
    }
  }
  return null;
}

export function buildInfo(): BuildInfo {
  if (cached !== null) return cached;
  const file = readBuildFile();
  cached = {
    version:
      typeof file?.version === "string" ? file.version : VERSION,
    git_sha:
      typeof file?.git_sha === "string"
        ? file.git_sha
        : process.env.BRIDGE_BUILD_SHA ?? null,
    dirty:
      typeof file?.dirty === "boolean"
        ? file.dirty
        : process.env.BRIDGE_BUILD_DIRTY === undefined
          ? null
          : process.env.BRIDGE_BUILD_DIRTY === "1",
    built_at:
      typeof file?.built_at === "string"
        ? file.built_at
        : process.env.BRIDGE_BUILT_AT ?? null,
  };
  return cached;
}
