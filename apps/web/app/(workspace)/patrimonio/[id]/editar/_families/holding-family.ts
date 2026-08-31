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
 * The connected SOURCE wins over everything for the two mirrored families: a
 * Numista coin collection and a Binance crypto rung are `derived` (ADR 0016/0021)
 * but mirror positions instead of keeping an operations ledger, so a method-first
 * switch would offer them a ledger they have not got — and an instrument-first one
 * trusts a column that a backfill could get wrong. It did: the v14 instrument
 * backfill filed every collection connected before it as `other` (#1691, ADR 0102), so those
 * fichas rendered the hand-valued surface, with no coin lens and with a picker
 * offering to relabel the one holding whose identity is not the user's to correct.
 * The adapter is the fact; the instrument is a column that should agree with it.
 */

import type { Instrument, SourceAdapter, ValuationMethod } from "@worthline/domain";

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
   * The adapter of the connected source that owns this holding, when one does
   * (#248, #1691). It is the single thing that separates a mirrored holding from a
   * hand-kept one, and it outranks the instrument column below.
   */
  connectedSourceAdapter?: SourceAdapter | null;
}

/** The one place a holding is routed to its surface family. */
export function holdingFamily(input: HoldingFamilyInput): HoldingFamily {
  if (input.kind === "liability") {
    return "debt";
  }

  // The source first: a mirrored holding is routed by who syncs it, never by the
  // instrument column it happens to carry (#1691).
  if (input.connectedSourceAdapter === "numista") {
    return "coin-collection";
  }
  if (input.connectedSourceAdapter === "binance") {
    return "binance";
  }

  // No source: a `coin_collection` instrument with nothing syncing it should not
  // exist (a disconnect freezes it to `precious_metal`), but routing it here keeps
  // an orphan on the surface that matches what it says it is.
  if (input.instrument === "coin_collection") {
    return "coin-collection";
  }

  if (input.method === "derived") {
    return "investment";
  }

  if (input.method === "appreciating") {
    return "housing";
  }

  return "stored";
}
