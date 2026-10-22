import { BridgeError } from "../errors.js";
import type { TaskRecord } from "../types.js";
import type { OpenCodeHttpClient } from "./http-client.js";
import type { OpenCodeModel } from "./types.js";

export async function resolveOpenCodeModel(
  client: OpenCodeHttpClient,
  task: TaskRecord,
): Promise<OpenCodeModel> {
  const models = await client.models();
  const candidates = models.filter(
    (model) =>
      model.providerID === task.provider_id &&
      (model.id === task.model_id || model.modelID === task.model_id),
  );

  const model = candidates[0];
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

export function modelCostKnown(model: OpenCodeModel): boolean {
  return Array.isArray(model.cost) && model.cost.length > 0;
}
