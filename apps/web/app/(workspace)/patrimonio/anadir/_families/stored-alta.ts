/**
 * The alta of a stored holding (#1611): a current account, a plazo fijo, a metal
 * hoard, a car, a «bien».
 *
 * Stored is the family with nothing behind the figure — its value is what
 * somebody typed, and it stays that until somebody types another (ADR 0014). So
 * this command is the whole family: name it, value it, say who owns it, write it.
 * It asks for no acquisition date, seeds no curve and reads no debt.
 */

import { parseAssetCommandStrict } from "@web/intake";
import { persistManualAssetCreation } from "@web/patrimonio/persist-holding";
import type { LiquidityTier } from "@worthline/domain";
import type { AltaContext, AltaResult } from "./alta-contract";
import { carry, carryOwnership, SHARED_REFILL_FIELDS } from "./alta-form";

/** What the stored pane posts and gets back after a rejected alta. */
export const STORED_REFILL_FIELDS: readonly string[] = [...SHARED_REFILL_FIELDS, "value"];

/** The catalog facts the routing already resolved for this family. */
export interface StoredAltaSpec {
  /** The legacy AssetType this instrument persists as (#309). */
  assetType: "cash" | "manual";
  rung: LiquidityTier;
}

/** Re-scope the unified form to the canonical names `parseAssetCommandStrict` reads. */
function scopedStoredForm(ctx: AltaContext, spec: StoredAltaSpec): FormData {
  const scoped = new FormData();
  // The type and the rung are INJECTED from the instrument catalog, never read
  // from a "Tipo"/"Capa" dropdown the form could disagree with (#151).
  scoped.set("type", spec.assetType);
  scoped.set("liquidityTier", spec.rung);
  carry(ctx.formData, scoped, `name_${ctx.instrument}`, "name");
  carry(ctx.formData, scoped, `value_${ctx.instrument}`, "currentValue");
  carryOwnership(ctx.formData, scoped);

  return scoped;
}

export async function runStoredAlta(
  ctx: AltaContext,
  spec: StoredAltaSpec,
): Promise<AltaResult> {
  const scoped = scopedStoredForm(ctx, spec);
  const workspace = await ctx.store.workspace.readWorkspace();

  if (!workspace) {
    return { ok: false, message: "Workspace no inicializado." };
  }

  const parsed = parseAssetCommandStrict(scoped, workspace.members, ctx.seed, ctx.today);

  if (!parsed.ok) {
    return { ok: false, message: parsed.error };
  }

  const result = await persistManualAssetCreation(
    ctx.store,
    workspace,
    { ...parsed.command, instrument: ctx.instrument },
    ctx.seed,
    ctx.today,
  );

  return result.ok
    ? { ok: true, created: { holdingId: result.id, okKey: "asset_added" } }
    : { ok: false, message: result.error };
}
