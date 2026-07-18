import type { AssetStore } from "@db/asset-store";
import { buildHistoricalSnapshotDeps } from "@db/historical-snapshot-deps";
import type { LiabilityStore } from "@db/liability-store";
import type { MigrateResult } from "@db/migrate";
import type { SnapshotStore } from "@db/snapshot-store";
import type { StoreContext } from "@db/store-context";
import type {
  DatedFactCommandImplementations,
  DatedFactStores,
} from "./command-implementation-types";
import { createDebtBalanceCommands } from "./debt-balance-facts";
import { createDebtPlanCommands } from "./debt-plan-facts";
import { createInvestmentOperationCommands } from "./investment-operations";
import { createOwnershipCommands } from "./ownership-facts";
import {
  rippleHistoricalSnapshotsForDebt,
  rippleHousingAfterEdit,
} from "./ripple-engine";
import { createStatementImportCommands } from "./statement-import";
import { createUnitOfWork } from "./unit-of-work";
import { createValuationCommands } from "./valuation-facts";

/**
 * Compose the private dated-fact command implementations (issues #489/#972) from
 * the per-family factories (#1117 decomposition, architecture review jul 2026).
 * Each family persists ONE dated fact AND ripples the historical snapshots it
 * touches, atomically in one transaction (ADR 0020/0062); the shared ripple
 * engine lives in `./ripple-engine`, and the families depend on it, never on one
 * another. The composition root supplies persistence ports and a single
 * `UnitOfWork`; the resulting suffix-free intent surface is exposed through
 * `CommandHost` and never appears on `WorthlineStore`.
 */
export function createDatedFactCommandImplementations(
  ctx: StoreContext,
  stores: DatedFactStores,
): DatedFactCommandImplementations {
  const uow = createUnitOfWork(ctx);
  return {
    ...createInvestmentOperationCommands(ctx, stores, uow),
    ...createStatementImportCommands(ctx, stores, uow),
    ...createValuationCommands(ctx, stores, uow),
    ...createOwnershipCommands(ctx, stores),
    ...createDebtBalanceCommands(ctx, stores, uow),
    ...createDebtPlanCommands(ctx, stores),
  };
}

/**
 * Post-migrate snapshot reconstruction (issue #491): after the migration ladder
 * runs at store construction, two backfills demand that frozen historical
 * snapshots be re-rippled atomically at migration time rather than drifting
 * silently on the next curve touch. This is snapshot-reconstruction LOGIC, so it
 * lives behind the dated-fact seam module, not in the thin wiring factory.
 */
export async function applyPostMigrateReripples(
  ctx: StoreContext,
  migrateResult: MigrateResult,
  stores: { assets: AssetStore; liabilities: LiabilityStore; snapshots: SnapshotStore },
): Promise<void> {
  // ADR 0019 (#188): after the v18 backfill, re-ripple every amortizable debt
  // so historical snapshots are rewritten from the new two-date curve. For
  // day<=28 plans the new curve is byte-identical to the old single-date curve,
  // so re-ripple is a no-op for figures. For day>=29 plans the clamped
  // first_payment shifts the cadence (addMonths(addMonths(start,1),m-1) ≠
  // addMonths(start,m)), so frozen snapshots must be corrected now — atomically
  // at migration time — rather than drifting silently on the next curve touch.
  if (migrateResult.ranV18Backfill) {
    const workspace = await ctx.getWorkspace();
    if (workspace) {
      const today = new Date().toISOString().slice(0, 10);
      const deps = await buildHistoricalSnapshotDeps(ctx.db, workspace);
      for (const [liabilityId, curve] of deps.debtBalanceByLiability) {
        if (curve.debtModel === "amortizable" && curve.plan) {
          await rippleHistoricalSnapshotsForDebt(
            ctx,
            workspace,
            stores.snapshots.saveSnapshot,
            {
              kind: "amortizable-plan",
              liabilityId,
              today,
            },
          );
        }
      }
    }
  }

  // v33 (ADR 0031, #393): the cadence column was just added to an existing DB, so
  // the modeled default flipped from interpolated to step (#390–392). Re-ripple
  // every modeled holding so stale interpolated daily-captures are rewritten as
  // steps. This fires ONLY on a genuine upgrade (ranV33Backfill), so fresh-DB
  // tests are unaffected. Mirrors the ranV18Backfill block's structure.
  if (migrateResult.ranV33Backfill) {
    const workspace = await ctx.getWorkspace();
    if (workspace) {
      const today = new Date().toISOString().slice(0, 10);
      const deps = await buildHistoricalSnapshotDeps(ctx.db, workspace);
      // Debts: amortizable plans re-ripple from their plan (every cuota boundary);
      // revolving with at least one anchor re-ripple from its earliest anchor.
      // Informal is already a step, and revolving with no anchors is flat — nothing
      // stale to correct in either, so both are skipped.
      for (const [liabilityId, curve] of deps.debtBalanceByLiability) {
        if (curve.debtModel === "amortizable" && curve.plan) {
          await rippleHistoricalSnapshotsForDebt(
            ctx,
            workspace,
            stores.snapshots.saveSnapshot,
            {
              kind: "amortizable-plan",
              liabilityId,
              today,
            },
          );
        } else if (
          curve.debtModel === "revolving" &&
          curve.anchors &&
          curve.anchors.length > 0
        ) {
          const earliestAnchorDate = [...curve.anchors]
            .map((a) => a.anchorDate)
            .sort()[0]!;
          await rippleHistoricalSnapshotsForDebt(
            ctx,
            workspace,
            stores.snapshots.saveSnapshot,
            {
              fromDateKey: earliestAnchorDate,
              kind: "anchor",
              liabilityId,
              today,
            },
          );
        }
      }
      // Housing: every appreciating asset re-ripples via the existing helper.
      for (const assetId of deps.housingValuationByAsset.keys()) {
        await rippleHousingAfterEdit(
          ctx,
          { assets: stores.assets, snapshots: stores.snapshots },
          assetId,
          today,
        );
      }
    }
  }
}
