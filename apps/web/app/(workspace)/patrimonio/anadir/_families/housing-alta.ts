/**
 * The alta of a vivienda (#1611): the appreciating family.
 *
 * A property is not a figure somebody typed — it is a curve. What the alta
 * collects (the acquisition date, the market value on that day, optionally what
 * was disbursed to buy it and a revaluation rate) seeds the anchor the histórico
 * is cut from, and the write ripples the snapshots back to that date (PRD #108,
 * ADR 0020). That is why this is its own family: none of it exists for a stored
 * holding, and the one thing it adds on top — the acquisition question below —
 * is meaningless anywhere else.
 *
 * The question (#1561): the simple wizard's inmueble drawer never asks WHEN the
 * flat was bought, it stamps today. A piso bought in 2004 then enters the book as
 * if it had been bought this morning, and the mortgage that financed it — whose
 * own curve does reach back to 2004 — drops out of every graph dated before today
 * (#1436, the Plasencia case). So the alta reads the debts' start dates BEFORE
 * writing (a fresh asset carries no debt of its own) and only when the date is
 * today's, so a historical acquisition pays for no read. It asks; it never
 * rejects — only the user knows the real date.
 */

import {
  acquisitionDatedToday,
  acquisitionTodayNotice,
  parseAssetCommandStrict,
} from "@web/intake";
import { readDebtHistoryStarts } from "@web/patrimonio/debt-history-starts";
import { persistManualAssetCreation } from "@web/patrimonio/persist-holding";
import type { LiquidityTier } from "@worthline/domain";
import type { AltaContext, AltaResult } from "./alta-contract";
import {
  carry,
  carryOwnership,
  requireWorkspace,
  SHARED_REFILL_FIELDS,
} from "./alta-form";

/** What the vivienda pane posts and gets back after a rejected alta. */
export const HOUSING_REFILL_FIELDS: readonly string[] = [
  ...SHARED_REFILL_FIELDS,
  "acqDate",
  "acqValue",
  // What was disbursed to acquire the property (#1441). Refilled for the same
  // reason the investment cost is: it comes off the escritura, and re-typing it
  // means going back to the paperwork.
  "acqCost",
  "rate",
  "isPrimaryResidence",
];

/** The catalog facts the routing already resolved for this family. */
export interface HousingAltaSpec {
  rung: LiquidityTier;
}

/**
 * Re-scope the unified form to the canonical names `parseAssetCommandStrict`
 * reads. No `currentValue`: a property is worth its acquisition value on the day
 * it enters the book, and the parser takes it from the anchor.
 */
function scopedHousingForm(ctx: AltaContext, spec: HousingAltaSpec): FormData {
  const scoped = new FormData();
  // Injected from the instrument catalog, never read from a dropdown (#151).
  scoped.set("type", "real_estate");
  scoped.set("liquidityTier", spec.rung);
  carry(ctx.formData, scoped, `name_${ctx.instrument}`, "name");
  carry(ctx.formData, scoped, `acqDate_${ctx.instrument}`, "acquisitionDate");
  carry(ctx.formData, scoped, `acqValue_${ctx.instrument}`, "acquisitionValue");
  carry(ctx.formData, scoped, `acqCost_${ctx.instrument}`, "acquisitionCost");
  carry(ctx.formData, scoped, `rate_${ctx.instrument}`, "rate");
  carry(
    ctx.formData,
    scoped,
    `isPrimaryResidence_${ctx.instrument}`,
    "isPrimaryResidence",
  );
  carryOwnership(ctx.formData, scoped);

  return scoped;
}

export async function runHousingAlta(
  ctx: AltaContext,
  spec: HousingAltaSpec,
): Promise<AltaResult> {
  const scoped = scopedHousingForm(ctx, spec);
  const found = await requireWorkspace(ctx);

  if (!found.ok) {
    return found;
  }

  const { workspace } = found;
  const parsed = parseAssetCommandStrict(scoped, workspace.members, ctx.seed, ctx.today);

  if (!parsed.ok) {
    return { ok: false, message: parsed.error };
  }

  const notice = acquisitionDatedToday({
    acquisitionDate: parsed.command.acquisitionDate,
    today: ctx.today,
  })
    ? acquisitionTodayNotice({
        acquisitionDate: parsed.command.acquisitionDate,
        debtStarts: await readDebtHistoryStarts(ctx.store),
        today: ctx.today,
      })
    : null;

  const result = await persistManualAssetCreation(
    ctx.store,
    workspace,
    { ...parsed.command, instrument: ctx.instrument },
    ctx.seed,
    ctx.today,
  );

  if (!result.ok) {
    return { ok: false, message: result.error };
  }

  // The redirect carries a QUESTION, so it does not scroll to the new row: the
  // band that asks it sits above, off-screen (#1561).
  return notice
    ? {
        ok: true,
        created: {
          holdingId: result.id,
          jumpToHolding: false,
          okKey: "asset_added_acquisition_today",
          params: { deudaDesde: notice.earliestDebtStart },
        },
      }
    : { ok: true, created: { holdingId: result.id, okKey: "asset_added" } };
}
