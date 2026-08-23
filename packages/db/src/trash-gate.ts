import type { DecimalString, HoldingTrashRefusal, TrashExit } from "@worthline/domain";
import { checkHoldingTrashGate, netUnitsFromOperations } from "@worthline/domain";

import { readCashContainerPortfolioName } from "./managed-portfolio-store";
import { readAssetOperations } from "./operations-store";
import type { StoreContext } from "./store-context";

/**
 * The Papelera's gate, at the seam every writer goes through (#1549, ADR 0085).
 *
 * The rule itself is pure and lives in the domain (`checkHoldingTrashGate`); this
 * module is the two reads it needs, and it sits INSIDE `softDeleteAsset` rather
 * than in the Server Action for the reason #1468 measured: the assistant writes
 * below the web's guards. A gate on the ficha alone would be a gate the chat can
 * walk around — and the chat is exactly where "bórrame el Groupama" gets typed.
 *
 * Cost: two indexed reads on a gesture a human performs once in a while, and both
 * are the SAME functions their other callers use — `readAssetOperations` (whose ORDER
 * BY the fold depends on) and `readCashContainerPortfolioName` (which the ficha calls
 * through the store to pre-empt this refusal on screen). A private copy of either
 * would be a second answer to the same question.
 *
 * Mirrors `valuation-guard.ts`, the other store-level guard in this package.
 */
export async function checkAssetTrashGate(
  ctx: StoreContext,
  assetId: string,
  exit: TrashExit | null,
): Promise<HoldingTrashRefusal | null> {
  return checkHoldingTrashGate({
    containerPortfolio: await readCashContainerPortfolioName(ctx, assetId),
    exit,
    netUnits: await readNetUnits(ctx, assetId),
  });
}

/**
 * The holding's net units, or `null` when it keeps no operations ledger at all.
 *
 * Folded by `netUnitsFromOperations` — the same fold the ficha, the board and the
 * health engine use — never by a units-only sum here: a second fold would clamp
 * over-sells differently and let the gate disagree with the figure the screen just
 * showed (#1438's lesson).
 */
async function readNetUnits(
  ctx: StoreContext,
  assetId: string,
): Promise<DecimalString | null> {
  const operations = await readAssetOperations(ctx, assetId);
  return operations.length === 0 ? null : netUnitsFromOperations(operations);
}
