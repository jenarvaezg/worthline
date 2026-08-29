/**
 * Which surface family a holding's ficha renders (#1607).
 *
 * The edit page used to answer this question inline, in a dozen booleans
 * (`isCoinCollection`, `isBinanceHolding`, `isDerived`, `isMarketInvestment`,
 * `hasManualLedger`…) re-tested at every read and again at every section. That
 * made the page the place where "what kind of holding is this?" was decided —
 * and, because each boolean was spelled out again where it was used, the place
 * where the answer could drift from itself.
 *
 * This module owns the decision, and only the decision: no reads, no rendering.
 * The page resolves the holding, asks here which family it belongs to, and hands
 * the rest to that family's loader. Adding a family means adding a branch here
 * and a module beside it — never another boolean in the page.
 *
 * The instrument wins over the valuation method for the two connected-source
 * families: a Numista coin collection and a Binance crypto rung are `derived`
 * (ADR 0016/0021) but mirror positions instead of keeping an operations ledger,
 * so a method-first switch would offer them a ledger they have not got.
 */

import type { Instrument, ValuationMethod } from "@worthline/domain";

/** The surface families a ficha can render. One module per value. */
export type HoldingFamily =
  | "binance"
  | "coin-collection"
  | "debt"
  | "housing"
  | "investment"
  | "stored";

export interface HoldingFamilyInput {
  /** Which side of the balance sheet the holding sits on. */
  kind: "asset" | "liability";
  /** The asset's instrument; absent for a liability. */
  instrument?: Instrument | null;
  /** The asset's valuation method (#152, ADR 0014); absent for a liability. */
  method?: ValuationMethod | null;
  /**
   * Whether this crypto asset is a rung of a connected Binance source. Only
   * asked of a `crypto` instrument, and it is the single thing that separates a
   * mirrored holding from a hand-kept one (#248).
   */
  hasBinanceSource?: boolean;
}

/** The one place a holding is routed to its surface family. */
export function holdingFamily(input: HoldingFamilyInput): HoldingFamily {
  if (input.kind === "liability") {
    return "debt";
  }

  if (input.instrument === "coin_collection") {
    return "coin-collection";
  }

  if (input.instrument === "crypto" && input.hasBinanceSource === true) {
    return "binance";
  }

  if (input.method === "derived") {
    return "investment";
  }

  if (input.method === "appreciating") {
    return "housing";
  }

  return "stored";
}
