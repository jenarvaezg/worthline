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
import type { ValuationMethod } from "./holding-valuation";
import { defaultValuationMethodForDebtModel } from "./holding-valuation";
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
  if (asset.connectedSourceId != null) {
    return false;
  }
  return valuationMethodOfAsset(asset) !== "derived";
}

/**
 * Whether a holding keeps an **operation ledger** — the individual buys and sells
 * a surface can count one by one, rather than a balance somebody sets.
 *
 * Two holdings are excluded and both would count zero if they were not: a
 * stored-value holding (its contributions are folded into a balance) and a
 * connected-source holding, which is `derived` from its **positions**, not from
 * operations (ADR 0014/0016). The annual contribution allowance (#1567) further
 * restricts destinations to `pension_plan` via `consumesContributionAllowance`.
 */
export function keepsAnOperationLedger(asset: ManualAsset): boolean {
  if (asset.connectedSourceId != null) {
    return false;
  }
  return valuationMethodOfAsset(asset) === "derived";
}

/**
 * Whether a holding's real entries consume a **contribution allowance** (#1567).
 *
 * The cupo counts aportaciones to **pension plans**, not every investment with a
 * ledger. A fund can keep operations and still not be a destination — marking one
 * by hand was the selector #1483 had to reword, and the palanca that let an
 * apertura eat the year's ceiling (#1504). Instrument `pension_plan` is the native
 * type; the ledger predicate stays as the inner gate so a connected-source plan
 * (no operations) cannot print "0 € de 1.500 €".
 */
export function consumesContributionAllowance(asset: ManualAsset): boolean {
  return keepsAnOperationLedger(asset) && instrumentOfAsset(asset) === "pension_plan";
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
