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
 * The single read this module makes of its own is the connected-source back-link,
 * because it is not a fact about the holding — it is the routing question itself,
 * and only an asset that carries the back-link column pays for it (see
 * {@link readConnectedSourceOfAsset}).
 *
 * Null is the answer for an id that resolved to neither an asset nor a liability
 * — a holding archived between the route table and this read. The page turns it
 * into the 404 it is, and no loader below has to carry a guard for it.
 */

import type { Liability, ManualAsset } from "@worthline/domain";
import { instrumentOfAsset, valuationMethodOfAsset } from "@worthline/domain";
import type { ReactNode } from "react";
import { loadBinanceSurface, readConnectedSourceOfAsset } from "./binance-family";
import { loadCoinCollectionSurface } from "./coin-collection-family";
import { loadDebtSurface } from "./debt-family";
import type { AssetFamilyContext, FichaContext, HoldingSurface } from "./family-contract";
import type { HoldingFamily } from "./holding-family";
import { holdingFamily } from "./holding-family";
import { loadHousingSurface } from "./housing-family";
import { loadInvestmentSurface } from "./investment-family";
import { loadStoredSurface } from "./stored-family";

export async function loadHoldingSurface(
  input: FichaContext & {
    asset: ManualAsset | null;
    liability: Liability | null;
    /** The shared Cobros panel; null when the holding is a liability's. */
    payoutsPanel: ReactNode;
  },
): Promise<HoldingSurface | null> {
  const { asset, liability, payoutsPanel, ...ficha } = input;

  if (asset) {
    const ctx = { ...ficha, asset, payoutsPanel };
    const connectedSource = await readConnectedSourceOfAsset(ficha.store, asset);
    const method = valuationMethodOfAsset(asset);
    const family = holdingFamily({
      connectedSourceAdapter: connectedSource?.adapter ?? null,
      instrument: instrumentOfAsset(asset),
      kind: "asset",
      method,
    });

    // The routing decision and the row that justifies it travel together, so the
    // Binance loader takes a source it cannot be missing — `holdingFamily` says
    // "binance" for exactly the assets this read resolved one for.
    const surface =
      family === "binance" && connectedSource !== null
        ? await loadBinanceSurface(ctx, connectedSource)
        : await loadAssetFamilySurface(family, ctx);

    // The method was derived here to route; «Lo básico» reads the same value
    // rather than deriving it a second time in the page (#152, ADR 0014).
    return { ...surface, basics: { ...surface.basics, method } };
  }

  return liability ? loadDebtSurface({ ...ficha, liability }) : null;
}

/** The families that need nothing but the asset context. */
function loadAssetFamilySurface(
  family: HoldingFamily,
  ctx: AssetFamilyContext,
): Promise<HoldingSurface> | HoldingSurface {
  switch (family) {
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
