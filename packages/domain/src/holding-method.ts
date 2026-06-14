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
 * The valuation method a liability is configured by — its debt model decides:
 * `amortizable` → `amortized`, `revolving`/`informal` → `anchored`, no model →
 * `stored`. A thin alias over `defaultValuationMethodForDebtModel` so the page's
 * dispatch reads off one holding→method seam.
 */
export function valuationMethodOfLiability(debtModel: DebtModel | null): ValuationMethod {
  return defaultValuationMethodForDebtModel(debtModel);
}
