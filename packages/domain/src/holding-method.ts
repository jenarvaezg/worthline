/**
 * Holding → valuation-method dispatch (#152, ADR 0014).
 *
 * The per-holding detail page (`/patrimonio/[id]/editar`) fans out its
 * configuration surface by the holding's **valuation method**. These two
 * helpers are the single source of that decision, built on the existing
 * derivation — an asset's method comes from its instrument's defaults
 * (`defaultsFor(instrumentOfAsset(asset))`), a liability's from its debt model
 * (`defaultValuationMethodForDebtModel`). No new vocabulary, no re-derivation.
 */

import { instrumentOfAsset } from "./classification";
import { defaultValuationMethodForDebtModel } from "./holding-valuation";
import type { ValuationMethod } from "./holding-valuation";
import { defaultsFor } from "./instrument-catalog";
import type { DebtModel, ManualAsset } from "./workspace-types";

/**
 * The valuation method an asset is configured by — sourced from its instrument's
 * defaults (ADR 0014). An investment (instrument `fund`/`etf`/…) is `derived`,
 * a property `appreciating`, cash/manual `stored`.
 */
export function valuationMethodOfAsset(asset: ManualAsset): ValuationMethod {
  return defaultsFor(instrumentOfAsset(asset)).valuationMethod;
}

/**
 * Whether an asset appears in (and can be edited by) the manual value-update pass
 * ("puesta al día"). A `derived` holding is valued from its sub-detail, never
 * hand-set — an investment from its operations + price, a connected-source coin
 * collection from its positions (ADR 0014/0016) — so it is excluded. Every other
 * method (stored, appreciating, …) is hand-valued and eligible. This is the single
 * seam both the value-update page (what it lists) and its action (what it rejects)
 * read, so the two never drift.
 */
export function isValueUpdateEligible(asset: ManualAsset): boolean {
  return valuationMethodOfAsset(asset) !== "derived";
}

/**
 * The valuation method a liability is configured by — its debt model decides:
 * `amortizable` → `amortized`, `revolving`/`informal` → `anchored`, no model →
 * `stored`. A thin alias over `defaultValuationMethodForDebtModel` so the page's
 * dispatch reads off one holding→method seam.
 */
export function valuationMethodOfLiability(debtModel: DebtModel | null): ValuationMethod {
  return defaultValuationMethodForDebtModel(debtModel);
}
