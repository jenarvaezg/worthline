import type { DecimalString, HoldingTrashRefusal, TrashExit } from "@worthline/domain";
import { checkHoldingTrashGate, netUnitsFromOperations } from "@worthline/domain";
import { asc, eq } from "drizzle-orm";

import {
  assetOperations,
  assets,
  managedPortfolioHoldings,
  managedPortfolios,
} from "./schema";
import { type StoreContext, toOperation } from "./store-context";

/**
 * The Papelera's gate, at the seam every writer goes through (#1549, ADR 0085).
 *
 * The rule itself is pure and lives in the domain (`checkHoldingTrashGate`); this
 * module is the two reads it needs, and it sits INSIDE `softDeleteAsset` rather
 * than in the Server Action for the reason #1468 measured: the assistant writes
 * below the web's guards. A gate on the ficha alone would be a gate the chat can
 * walk around — and the chat is exactly where "bórrame el Groupama" gets typed.
 *
 * Cost: two indexed reads on a gesture a human performs once in a while. The
 * ledger read is the same range scan the ficha already does (`asset_id` index),
 * and the membership read hits the unique index on `managed_portfolio_holdings`.
 *
 * Mirrors `valuation-guard.ts`, the other store-level guard in this package.
 */
export async function checkAssetTrashGate(
  ctx: StoreContext,
  assetId: string,
  exit: TrashExit | null,
): Promise<HoldingTrashRefusal | null> {
  return checkHoldingTrashGate({
    containerPortfolio: await readContainerPortfolioName(ctx, assetId),
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
  const rows = await ctx.db
    .select()
    .from(assetOperations)
    .where(eq(assetOperations.assetId, assetId))
    .orderBy(
      asc(assetOperations.executedAt),
      asc(assetOperations.occurredAt),
      asc(assetOperations.id),
    )
    .all();

  return rows.length === 0 ? null : netUnitsFromOperations(rows.map(toOperation));
}

/**
 * The managed portfolio whose CASH sibling this holding is, or null.
 *
 * Only the cash box is protected, not every member: a member fund is an ordinary
 * position with an ordinary ledger, and selling it and archiving it is a legitimate
 * thing to do inside a live cartera. The cash is different — the alta created it,
 * the owner never did, and while the cartera lives it is a casilla of the container
 * (ADR 0085). Members other than the cash sibling are investments by construction,
 * so "is a member and is not an investment" IS "is the cash box".
 */
async function readContainerPortfolioName(
  ctx: StoreContext,
  assetId: string,
): Promise<string | null> {
  const row = await ctx.db
    .select({ name: managedPortfolios.name, type: assets.type })
    .from(managedPortfolioHoldings)
    .innerJoin(
      managedPortfolios,
      eq(managedPortfolios.id, managedPortfolioHoldings.portfolioId),
    )
    .innerJoin(assets, eq(assets.id, managedPortfolioHoldings.assetId))
    .where(eq(managedPortfolioHoldings.assetId, assetId))
    .get();

  return row && row.type !== "investment" ? row.name : null;
}
