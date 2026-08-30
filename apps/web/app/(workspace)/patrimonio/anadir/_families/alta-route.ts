/**
 * Which family an alta belongs to, and what the catalog said on the way (#1611).
 *
 * `createHoldingAction` used to answer this question inline, as three sequential
 * `if`s over the instrument catalog's defaults, each one followed by the whole
 * body of that family's alta: the manual-asset path, the derived-investment path
 * with its opening/traspaso captures, the liability path with its debt model and
 * its «alta por estado actual» block. Nine hundred lines in which adding an
 * instrument meant reading — and risking — all four.
 *
 * This module owns the decision, and only the decision: no parsing, no reads, no
 * writes. It is the alta's counterpart to `holdingFamily` (ADR 0095), which does
 * the same for the ficha, and it is deliberately a different function: the ficha
 * routes a holding that EXISTS (it has an asset row, a valuation method, maybe a
 * connected source), while the alta routes an INSTRUMENT the user has just
 * picked, before there is anything to read.
 *
 * The order below is the catalog's own hierarchy and is not arbitrary:
 *
 * - A declared `assetType` means the instrument persists through the manual-asset
 *   path — `real_estate` is the appreciating family (an acquisition anchor, a
 *   revaluation curve), everything else is stored (a figure somebody typed).
 * - `derived` means units × price: the investment family.
 * - A declared `liability` means the debt family.
 *
 * What the route carries is what the catalog answered while routing — the rung,
 * the legacy AssetType, the price provider, the liability spec. It travels WITH
 * the decision so no command re-reads the catalog to recover the very fact that
 * sent it there, and so a command never carries a guard for a case it cannot be
 * called in (the debt command's liability spec is not optional).
 *
 * `null` is «no alta knows how to create this». Today no instrument the add form
 * offers lands there, which is exactly the property this module makes checkable:
 * a new instrument that forgets to declare how it persists gets a message instead
 * of falling into whichever branch happened to be last.
 */

import type {
  Instrument,
  InstrumentPriceProvider,
  LiabilityDefaults,
  LiquidityTier,
} from "@worthline/domain";
import { defaultsFor } from "@worthline/domain";

/** The alta families. One command module per value. */
export type AltaFamily = AltaRoute["family"];

/** The family an instrument belongs to, plus what the catalog said on the way. */
export type AltaRoute = {
  /** The liquidity-ladder rung the instrument suggests. */
  rung: LiquidityTier;
} & (
  | { family: "stored"; assetType: "cash" | "manual" }
  | { family: "housing" }
  | { family: "investment"; priceProvider?: InstrumentPriceProvider }
  | { family: "debt"; liability: LiabilityDefaults }
);

/** The one place an instrument is routed to its alta family. */
export function altaRoute(instrument: Instrument): AltaRoute | null {
  // A Numista collection is `derived` (ADR 0016) but nobody hand-creates one:
  // it appears by connecting the source, and its rows are mirrored positions,
  // not a ledger. Saying so here — rather than letting it fall into the
  // investment family, which is where a method-first switch would put it —
  // is what keeps the add form's vocabulary and the routing from disagreeing.
  if (instrument === "coin_collection") {
    return null;
  }

  const defaults = defaultsFor(instrument);
  const rung = defaults.rung;

  if (defaults.assetType) {
    return defaults.assetType === "real_estate"
      ? { family: "housing", rung }
      : { assetType: defaults.assetType, family: "stored", rung };
  }

  if (defaults.valuationMethod === "derived") {
    return {
      family: "investment",
      rung,
      ...(defaults.priceProvider ? { priceProvider: defaults.priceProvider } : {}),
    };
  }

  return defaults.liability
    ? { family: "debt", liability: defaults.liability, rung }
    : null;
}
