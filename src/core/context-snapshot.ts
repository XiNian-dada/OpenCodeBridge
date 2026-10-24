import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve, sep } from "node:path";
import { BridgeError } from "../errors.js";
import type { ContextFile } from "../types.js";

export const MAX_CONTEXT_FILES = 100;
export const MAX_CONTEXT_FILE_BYTES = 2 * 1024 * 1024;
export const MAX_CONTEXT_TOTAL_BYTES = 8 * 1024 * 1024;

/** Validate and normalize repository-relative context paths without touching disk. */
export function normalizeContextPaths(files: readonly string[]): string[] {
  if (files.length > MAX_CONTEXT_FILES) {
    throw new BridgeError(
      "INVALID_ARGUMENT",
      `context_files is limited to ${MAX_CONTEXT_FILES} files`,
      { details: { count: files.length } },
    );
  }
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const raw of files) {
    if (typeof raw !== "string" || raw.trim() === "") {
      throw new BridgeError("INVALID_ARGUMENT", "context_files entries must be non-empty strings");
    }
    const value = raw.trim().replaceAll("\\", "/");
    if (isAbsolute(value) || /^[A-Za-z]:\//.test(value)) {
      throw new BridgeError("INVALID_ARGUMENT", `context file must be repository-relative: ${raw}`);
    }
    const segments = value.split("/").filter((part) => part !== "" && part !== ".");
    if (segments.length === 0 || segments.includes("..")) {
      throw new BridgeError("INVALID_ARGUMENT", `unsafe context file path: ${raw}`);
    }
    const relative = segments.join("/");
    if (seen.has(relative)) continue;
    seen.add(relative);
    normalized.push(relative);
  }
  return normalized;
}

export async function inspectContextFiles(
  repoRoot: string,
  files: readonly string[],
): Promise<ContextFile[]> {
  const normalized = normalizeContextPaths(files);
  const root = await safeRealpath(repoRoot, "repository root");
  let total = 0;
  const result: ContextFile[] = [];

  for (const relative of normalized) {
    const absolute = resolve(root, relative);
    if (!isWithin(root, absolute)) {
      throw new BridgeError("INVALID_ARGUMENT", `context file escapes the repository: ${relative}`);
    }
    const real = await safeRealpath(absolute, `context file ${relative}`);
    if (!isWithin(root, real)) {
      throw new BridgeError("INVALID_ARGUMENT", `context file resolves outside the repository: ${relative}`);
    }
    const info = await stat(real).catch((error: unknown) => {
      throw new BridgeError("CONTEXT_SNAPSHOT_FAILED", `Cannot read context file: ${relative}`, {
        cause: error,
        details: { path: relative },
      });
    });
    if (!info.isFile()) {
      throw new BridgeError("INVALID_ARGUMENT", `context path is not a file: ${relative}`);
    }
    if (info.size > MAX_CONTEXT_FILE_BYTES) {
      throw new BridgeError(
        "INVALID_ARGUMENT",
        `context file is too large (max ${MAX_CONTEXT_FILE_BYTES} bytes): ${relative}`,
        { details: { path: relative, bytes: info.size } },
      );
    }
    total += info.size;
    if (total > MAX_CONTEXT_TOTAL_BYTES) {
      throw new BridgeError(
        "INVALID_ARGUMENT",
        `context snapshot exceeds ${MAX_CONTEXT_TOTAL_BYTES} bytes`,
        { details: { total_bytes: total } },
      );
    }
    const data = await readFile(real).catch((error: unknown) => {
      throw new BridgeError("CONTEXT_SNAPSHOT_FAILED", `Cannot read context file: ${relative}`, {
        cause: error,
        details: { path: relative },
      });
    });
    result.push({
      path: relative,
      sha256: createHash("sha256").update(data).digest("hex"),
      bytes: data.byteLength,
    });
  }
  return result;
}

export async function writeContextSnapshot(options: {
  repoRoot: string;
  files: readonly string[];
  destination: string;
  exclusive?: boolean;
}): Promise<{ files: ContextFile[]; total_bytes: number }> {
  const normalized = normalizeContextPaths(options.files);
  const root = await safeRealpath(options.repoRoot, "repository root");
  await mkdir(options.destination, { recursive: true, mode: 0o700 });
  const destination = await safeRealpath(options.destination, "context workspace");

  const files: ContextFile[] = [];
  let total = 0;
  for (const relative of normalized) {
    const source = resolve(root, relative);
    if (!isWithin(root, source)) {
      throw new BridgeError("INVALID_ARGUMENT", `context file escapes the repository: ${relative}`);
    }
    const real = await safeRealpath(source, `context file ${relative}`);
    if (!isWithin(root, real)) {
      throw new BridgeError("INVALID_ARGUMENT", `context file resolves outside the repository: ${relative}`);
    }
    const info = await stat(real).catch((error: unknown) => {
      throw new BridgeError("CONTEXT_SNAPSHOT_FAILED", `Cannot read context file: ${relative}`, {
        cause: error,
        details: { path: relative },
      });
    });
    if (!info.isFile()) {
      throw new BridgeError("INVALID_ARGUMENT", `context path is not a file: ${relative}`);
    }
    if (info.size > MAX_CONTEXT_FILE_BYTES) {
      throw new BridgeError("INVALID_ARGUMENT", `context file is too large: ${relative}`);
    }
    const data = await readFile(real);
    if (data.byteLength > MAX_CONTEXT_FILE_BYTES) {
      throw new BridgeError("INVALID_ARGUMENT", `context file is too large: ${relative}`);
    }
    total += data.byteLength;
    if (total > MAX_CONTEXT_TOTAL_BYTES) {
      throw new BridgeError("INVALID_ARGUMENT", "context snapshot is too large");
    }
    const target = resolve(destination, relative);
    if (!isWithin(destination, target)) {
      throw new BridgeError("INVALID_ARGUMENT", `unsafe context destination: ${relative}`);
    }
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    const parent = await safeRealpath(dirname(target), "context destination parent");
    if (!isWithin(destination, parent)) throw new BridgeError("INVALID_ARGUMENT", "Context destination escapes workspace");
    await writeFile(target, data, { mode: 0o600, ...(options.exclusive ? { flag: "wx" } : {}) });
    files.push({
      path: relative,
      sha256: createHash("sha256").update(data).digest("hex"),
      bytes: data.byteLength,
    });
  }
  return { files, total_bytes: total };
}

async function safeRealpath(path: string, label: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    throw new BridgeError("CONTEXT_SNAPSHOT_FAILED", `Cannot resolve ${label}`, {
      cause: error,
      details: { path },
    });
  }
}

function isWithin(root: string, candidate: string): boolean {
  const normalizedRoot = resolve(root);
  const normalizedCandidate = resolve(candidate);
  return (
    normalizedCandidate === normalizedRoot ||
    normalizedCandidate.startsWith(`${normalizedRoot}${sep}`)
  );
}
