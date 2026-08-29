/**
 * The ficha's one dispatch point (#1607): holding in, surface out.
 *
 * This is the whole branching the edit page used to do inline. The page now
 * resolves WHICH holding is being edited; this module answers WHAT it is and
 * hands the work to that family's loader. Two properties follow from that, and
 * both are the point of the refactor:
 *
 * - A family loads only what it paints. A cash account issues no read at all; a
 *   mortgage never touches the operations store; an investment never asks for a
 *   valuation anchor. Nothing here reads "just in case some branch needs it".
 * - Adding a family is adding a case here and a module beside it. No boolean is
 *   added to the page, and no existing family is re-read to make room.
 *
 * The single read this module makes of its own is the Binance back-link, because
 * it is not a fact about the holding — it is the routing question itself, and
 * only a `crypto` asset pays for it (see {@link readBinanceSource}).
 */

import { instrumentOfAsset, valuationMethodOfAsset } from "@worthline/domain";
import { loadBinanceSurface, readBinanceSource } from "./binance-family";
import { loadCoinCollectionSurface } from "./coin-collection-family";
import { loadDebtSurface } from "./debt-family";
import type { FamilyContext, HoldingSurface } from "./family-contract";
import { holdingFamily } from "./holding-family";
import { loadHousingSurface } from "./housing-family";
import { loadInvestmentSurface } from "./investment-family";
import { loadStoredSurface } from "./stored-family";

export async function loadHoldingSurface(ctx: FamilyContext): Promise<HoldingSurface> {
  const { asset, id, store } = ctx;

  if (!asset) {
    return loadDebtSurface(ctx);
  }

  const binanceSource = await readBinanceSource(store, {
    assetId: id,
    instrument: instrumentOfAsset(asset),
  });

  const family = holdingFamily({
    hasBinanceSource: binanceSource !== null,
    instrument: instrumentOfAsset(asset),
    kind: "asset",
    method: valuationMethodOfAsset(asset),
  });

  switch (family) {
    case "binance":
      return loadBinanceSurface(ctx, binanceSource);
    case "coin-collection":
      return loadCoinCollectionSurface(ctx);
    case "housing":
      return loadHousingSurface(ctx);
    case "investment":
      return loadInvestmentSurface(ctx);
    default:
      return loadStoredSurface(ctx);
  }
}
