import { execFileSync } from "node:child_process";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

function git(args) {
  try {
    return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

const gitSha = git(["rev-parse", "HEAD"]) || null;
const dirty = git(["status", "--porcelain", "--untracked-files=no"])
  ? true
  : gitSha === null
    ? null
    : false;

const info = {
  version: String(packageJson.version ?? "0.1.0"),
  git_sha: gitSha,
  dirty,
  built_at: new Date().toISOString(),
};

const output = new URL("../dist/build-info.json", import.meta.url);
mkdirSync(fileURLToPath(new URL("../dist", import.meta.url)), { recursive: true });
writeFileSync(output, `${JSON.stringify(info, null, 2)}\n`, { mode: 0o644 });
process.stdout.write(`${JSON.stringify(info)}\n`);
