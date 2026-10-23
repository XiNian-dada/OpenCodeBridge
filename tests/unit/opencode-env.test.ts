import { describe, expect, it } from "vitest";
import { sanitizeEnvironment } from "../../src/opencode/process.js";

describe("OpenCode child environment filtering", () => {
  it("keeps runtime and provider variables but drops unrelated credentials", () => {
    const env = sanitizeEnvironment({
      PATH: "/usr/bin",
      HOME: "/Users/example",
      LANG: "en_US.UTF-8",
      TMPDIR: "/tmp/task",
      OPENAI_API_KEY: "provider-key",
      DEEPSEEK_API_KEY: "provider-key-2",
      AWS_SECRET_ACCESS_KEY: "cloud-secret",
      GITHUB_TOKEN: "git-secret",
      SSH_AUTH_SOCK: "/tmp/agent.sock",
      OPENCODE_CONFIG: "/tmp/evil.json",
      NODE_OPTIONS: "--require /tmp/evil.js",
      LC_ALL: "en_US.UTF-8",
    });

    expect(env).toMatchObject({
      PATH: "/usr/bin",
      HOME: "/Users/example",
      LANG: "en_US.UTF-8",
      TMPDIR: "/tmp/task",
      OPENAI_API_KEY: "provider-key",
      DEEPSEEK_API_KEY: "provider-key-2",
      LC_ALL: "en_US.UTF-8",
    });
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.SSH_AUTH_SOCK).toBeUndefined();
    expect(env.OPENCODE_CONFIG).toBeUndefined();
    expect(env.NODE_OPTIONS).toBeUndefined();
  });
});
