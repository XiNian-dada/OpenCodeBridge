import { describe, expect, it } from "vitest";
import {
  findOpenCodeModel,
  gatewaySettingsFor,
} from "../../src/opencode/model-resolver.js";
import type { OpenCodeModel } from "../../src/opencode/types.js";
import type { TaskRecord } from "../../src/types.js";

function model(overrides: Partial<OpenCodeModel>): OpenCodeModel {
  return {
    id: "deepseek-v4.1-flash-free",
    modelID: "deepseek-v4.1-flash-free",
    providerID: "opencode",
    ...overrides,
  };
}

function task(): TaskRecord {
  return {
    provider_id: "opencode",
    model_id: "deepseek-v4.1-flash-free",
  } as TaskRecord;
}

describe("OpenCode model gateway settings", () => {
  it("finds the configured provider/model and accepts OpenAI-compatible packages", () => {
    const entry = model({
      package: "@opencode/ai/providers/openai-compatible",
      settings: {
        baseURL: "https://opencode.ai/inference/openai/v1",
        apiKey: "public",
      },
    });
    expect(findOpenCodeModel([entry], task())).toBe(entry);
    expect(gatewaySettingsFor(entry)).toEqual({
      supported: true,
      baseURL: "https://opencode.ai/inference/openai/v1",
      apiKey: "public",
      reason: null,
    });
  });

  it("rejects non-OpenAI-compatible providers and missing base URLs", () => {
    expect(
      gatewaySettingsFor(
        model({ package: "@ai-sdk/anthropic", settings: { baseURL: "https://example.com" } }),
      ),
    ).toMatchObject({ supported: false });
    expect(
      gatewaySettingsFor(
        model({ package: "@ai-sdk/openai-compatible", settings: { apiKey: "x" } }),
      ),
    ).toMatchObject({ supported: false });
  });
});
