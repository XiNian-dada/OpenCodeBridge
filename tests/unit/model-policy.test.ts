import { describe, expect, it } from "vitest";
import { BridgeError } from "../../src/errors.js";
import { ModelPolicy } from "../../src/policy/model-policy.js";
import type { BridgeConfig } from "../../src/config.js";

const base: BridgeConfig["models"] = {
  default: "mock/echo",
  allow: ["mock/echo", "vendor/expensive"],
  expensive: ["vendor/expensive"],
  allow_expensive: false,
  max_cost_usd: null,
  max_tokens: null,
};

describe("ModelPolicy", () => {
  it("resolves the default model and provider/model id", () => {
    const resolved = new ModelPolicy(base).resolve();
    expect(resolved).toMatchObject({
      model: "mock/echo",
      provider_id: "mock",
      model_id: "echo",
      variant: null,
    });
  });

  it("supports variants", () => {
    const resolved = new ModelPolicy(base).resolve("mock/echo#fast");
    expect(resolved.variant).toBe("fast");
  });

  it("defaults to deny for models outside the allowlist", () => {
    expect(() => new ModelPolicy(base).resolve("evil/model")).toThrowError(
      expect.objectContaining({ code: "MODEL_NOT_ALLOWED" }),
    );
  });

  it("requires explicit authorization for expensive models", () => {
    try {
      new ModelPolicy(base).resolve("vendor/expensive");
      throw new Error("expected failure");
    } catch (error) {
      expect(error).toBeInstanceOf(BridgeError);
      expect((error as BridgeError).code).toBe("MODEL_UPGRADE_REQUIRED");
    }
  });

  it("allows expensive models only when the config grants permission", () => {
    const policy = new ModelPolicy({ ...base, allow_expensive: true });
    expect(policy.resolve("vendor/expensive").expensive).toBe(true);
  });

  it("allows every Go model and variants while preserving provider boundaries", () => {
    const policy = new ModelPolicy({ ...base, allow: ["opencode-go/*"] });
    for (const id of ["deepseek-v4.1-flash", "deepseek-v4-pro", "future-model#fast"]) {
      expect(policy.resolve(`opencode-go/${id}`).provider_id).toBe("opencode-go");
    }
    for (const id of ["opencode/model", "opencode-go-evil/model", "evil/opencode-go/model"]) {
      expect(() => policy.resolve(id)).toThrowError(expect.objectContaining({ code: "MODEL_NOT_ALLOWED" }));
    }
    expect(() => policy.resolve("opencode-go/*")).toThrowError(expect.objectContaining({ code: "INVALID_ARGUMENT" }));
  });

  it("retains expensive-model authorization under a provider allow pattern", () => {
    const policy = new ModelPolicy({ ...base, allow: ["opencode-go/*"], expensive: ["opencode-go/deepseek-v4-pro"] });
    expect(() => policy.resolve("opencode-go/deepseek-v4-pro")).toThrowError(
      expect.objectContaining({ code: "MODEL_UPGRADE_REQUIRED" }),
    );
  });

  it("rejects missing defaults and malformed ids", () => {
    expect(() => new ModelPolicy({ ...base, default: null }).resolve()).toThrowError(
      expect.objectContaining({ code: "MODEL_NOT_ALLOWED" }),
    );
    expect(() => new ModelPolicy({ ...base, allow: ["bad"] }).resolve("bad")).toThrowError(
      expect.objectContaining({ code: "INVALID_ARGUMENT" }),
    );
  });
});
