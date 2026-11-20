import { sdmSchema, type SdmSpec } from "./spec";
import { sdmValidate } from "./serialize";
import type { ApplyResult, ModelController } from "./controller";

/** Caller pauses persistence until success so an invalid draft is never saved. */
export async function applySdm(controller: ModelController, draft: SdmSpec): Promise<ApplyResult> {
  const parsed = sdmSchema.safeParse(draft);
  if (!parsed.success) return { ok: false, errors: [parsed.error.message] };
  const errors = sdmValidate(parsed.data);
  if (errors.length) return { ok: false, errors };
  const previous = structuredClone(controller.spec);
  let result: ApplyResult;
  try { result = await controller.apply((s) => ({ ...s, sdm: parsed.data })); }
  catch (error) { result = { ok: false, errors: [error instanceof Error ? error.message : String(error)] }; }
  if (result.ok) return result;
  try {
    const restored = await controller.restore(previous);
    return { ok: false, errors: [...result.errors, ...(restored.ok
      ? ["The previous model was restored. Your draft remains open for correction."]
      : ["Restoring the previous model also failed.", ...restored.errors])] };
  } catch (error) {
    return { ok: false, errors: [...result.errors, `Could not restore the engine: ${String(error)}`] };
  }
}
