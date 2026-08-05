/**
 * Investment-operation plan (#1374) — the payload of an `investment_operation`
 * assistant proposal: ONE dated buy/sell against an investment holding that
 * ALREADY exists.
 *
 * Why it needed its own lane. The write inventory had a batch reconcile, an alta, a
 * correction and a statement import, and none of them takes «apúntame esta compra»:
 * a confirmation of a purchase or an aportación is not a portfolio, not a new
 * holding, and not a correction — it is a dated fact that goes into the ledger. With
 * no lane the model improvised with `propose_reconcile`, whose schema demands the
 * position's current `value`, and filled that mandatory field with a snapshot of the
 * portfolio: a figure the document does not contain, shown to the user as part of
 * the plan (#1373 is the card half of the same session).
 *
 * Every term here is OBSERVED on the document or derived from two observed figures,
 * never from the portfolio: the position's value is not a field anybody has to fill.
 * The whole write is reconstructed from this row at confirm time, so the web layer
 * cannot smuggle a different quantity past the preview the user agreed to.
 */

export interface InvestmentOperationPlan {
  /** The public holding id (`wl_hld_…`) the card echoes. */
  holding: string;
  /** Internal investment asset id the operation lands on. */
  assetId: string;
  /**
   * What the ledger records. An aportación to a plan de pensiones is a `buy` (ADR
   * 0006: an investment is always units × price); the card still says «aportación»,
   * because that is the word printed on the paper the user is holding.
   */
  kind: "buy" | "sell";
  /** YYYY-MM-DD the document dates the operation. */
  executedAt: string;
  /** Participaciones, decimal string — the document's own quantity. */
  units: string;
  /**
   * Unit price, decimal string. Derived as `(importe − comisión) / participaciones`
   * so the cash amount the document states is reproduced to the cent, which is the
   * same derivation the reconcile's matched rows persist. The document's PRINTED
   * price (a NAV rounded to two decimals) is kept only as a cross-check.
   */
  pricePerUnit: string;
  currency: string;
  /**
   * The ISIN the document prints, when it prints one. Kept because the confirm
   * re-checks it against the holding's registered ISIN: a paper about a different
   * instrument must not land here just because a day passed.
   */
  isin?: string;
  /**
   * The commission the document PRINTS, integer minor units. Present means the
   * document printed one — including a printed zero, which the card shows as
   * «comisión 0 €» — and absent means it printed none at all.
   */
  feesMinor?: number;
  /** The cash amount the document states, minor units: the figure the card printed. */
  amountMinor: number;
}
