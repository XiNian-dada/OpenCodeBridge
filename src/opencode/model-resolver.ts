import { BridgeError } from "../errors.js";
import type { TaskRecord } from "../types.js";
import type { OpenCodeHttpClient } from "./http-client.js";
import type { OpenCodeModel } from "./types.js";

export async function resolveOpenCodeModel(
  client: OpenCodeHttpClient,
  task: TaskRecord,
): Promise<OpenCodeModel> {
  const models = await client.models();
  const model = findOpenCodeModel(models, task);
  if (model === undefined) {
    throw new BridgeError(
      "MODEL_UNAVAILABLE",
      `OpenCode does not expose model ${task.provider_id}/${task.model_id}`,
      {
        details: {
          provider_id: task.provider_id,
          model_id: task.model_id,
          available: models.map((item) => `${item.providerID}/${item.modelID}`),
        },
      },
    );
  }

  return model;
}

export function findOpenCodeModel(
  models: OpenCodeModel[],
  task: TaskRecord,
): OpenCodeModel | undefined {
  return models.find(
    (model) =>
      model.providerID === task.provider_id &&
      (model.id === task.model_id || model.modelID === task.model_id),
  );
}

export function gatewaySettingsFor(model: OpenCodeModel): {
  supported: boolean;
  baseURL: string | null;
  apiKey: string | null;
  reason: string | null;
} {
  const baseURL = typeof model.settings?.baseURL === "string" ? model.settings.baseURL : null;
  const apiKey = typeof model.settings?.apiKey === "string" ? model.settings.apiKey : null;
  const packageName = typeof model.package === "string" ? model.package : "";
  if (baseURL === null) {
    return { supported: false, baseURL: null, apiKey, reason: "provider has no baseURL" };
  }
  if (!baseURL.startsWith("http://") && !baseURL.startsWith("https://")) {
    return { supported: false, baseURL, apiKey, reason: "provider baseURL is not HTTP(S)" };
  }
  if (
    packageName !== "" &&
    !packageName.includes("openai-compatible") &&
    !packageName.includes("@ai-sdk/openai")
  ) {
    return {
      supported: false,
      baseURL,
      apiKey,
      reason: `provider package is not OpenAI-compatible: ${packageName}`,
    };
  }
  return { supported: true, baseURL, apiKey, reason: null };
}

export function modelCostKnown(model: OpenCodeModel): boolean {
  return Array.isArray(model.cost) && model.cost.length > 0;
}
