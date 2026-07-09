import type { DecimalString, Workspace } from "@worthline/domain";
import {
  buildSnapshotAtDate,
  historicalCapturedAt,
  listScopeOptions,
  planPriceBackfill,
  recalculateSnapshotForAsset,
} from "@worthline/domain";

import {
  BACKFILL_SNAPSHOT_ID_PREFIX,
  buildHistoricalSnapshotDeps,
  groupFrozenHoldingsByDate,
  readFrozenIdentityCaptures,
  readInvestmentIdentity,
} from "./historical-snapshot-deps";
import {
  readSnapshotHoldings,
  readSnapshots,
  type SaveSnapshotInput,
  type SnapshotStore,
} from "./snapshot-store";
import { readAllOperations, type StoreContext } from "./store-context";

/**
 * Historical-price backfill ripple (#380, ADR 0033). The explicit, auditable
 * action that freezes a provider's historical unit prices onto ONE investment's
 * monthly snapshots — the ONLY path that rewrites historical `unit_price`. For
 * each priced monthly point in the plan it either generates a fresh whole-portfolio
 * snapshot at that date (if none exists) with this asset's row priced via
 * `capturedUnitPrices`, or recalculates the existing one — overriding ONLY this
 * asset's row (units × historical price) and preserving every OTHER frozen row
 * verbatim (ADR 0008/0012). It NEVER touches a date the plan did not price (a gap
 * stays a gap), nor any holding other than the backfilled one. Returns the
 * create/update counts for the audit summary.
 *
 * The inner `ctx.transaction` below composes with the caller's outer transaction:
 * StoreContext flattens nested transactions over the shared libSQL connection, so
 * the backfill still commits or rolls back as one unit.
 *
 * With `dryRun`, the same scope loop runs (read + pure build/recalc) but no row is
 * persisted — only the counts are returned, so the preview shares this path.
 */
export async function rippleHistoricalSnapshotsForPriceBackfill(
  ctx: StoreContext,
  workspace: Workspace,
  saveSnapshot: (input: SaveSnapshotInput) => Promise<void>,
  params: {
    assetId: string;
    points: readonly { dateKey: string; unitPriceDecimal: DecimalString }[];
    /** Count only — never persist (the preview's per-scope dry run). */
    dryRun?: boolean;
  },
): Promise<{ created: number; updated: number }> {
  const { db } = ctx;
  const { assetId, points, dryRun = false } = params;

  let created = 0;
  let updated = 0;

  if (points.length === 0) return { created, updated };

  // The operated asset's identity — read including trashed (it existed on the
  // snapshot dates even if trashed afterwards, ADR 0012).
  const asset = await readInvestmentIdentity(db, assetId);
  if (!asset) return { created, updated };
  const operations = (await readAllOperations(db)).get(assetId) ?? [];

  // The asset's frozen classification captures across every snapshot (#242),
  // read ONCE before any recalc mutates rows.
  const frozenIdentity = await readFrozenIdentityCaptures(db, assetId, "asset");

  await ctx.transaction(async () => {
    for (const scope of listScopeOptions(workspace)) {
      const existing = await readSnapshots(db, scope.id);
      const existingByDate = new Map(existing.map((snap) => [snap.dateKey, snap]));

      // Read this scope's frozen rows for the whole backfilled range in ONE query.
      const frozenByDate = groupFrozenHoldingsByDate(
        await readSnapshotHoldings(db, { scopeId: scope.id }),
      );

      for (const point of points) {
        const dateKey = point.dateKey;
        const snap = existingByDate.get(dateKey);

        if (snap === undefined) {
          // No snapshot on this date yet → generate a fresh whole-portfolio one,
          // pricing THIS asset's row from the historical quote (capturedUnitPrices
          // wins over the cost-basis fallback). Other holdings are valued by the
          // same fresh-capture path the operation ripple uses.
          const deps = await buildHistoricalSnapshotDeps(db, workspace);
          const built = buildSnapshotAtDate({
            assets: deps.assets,
            capturedAt: historicalCapturedAt(dateKey),
            capturedUnitPrices: new Map([[assetId, point.unitPriceDecimal]]),
            coinPositionsByAsset: deps.coinPositionsByAsset,
            costBasisAssetIds: deps.costBasisAssetIds,
            debtBalanceByLiability: deps.debtBalanceByLiability,
            housingValuationByAsset: deps.housingValuationByAsset,
            id: `${BACKFILL_SNAPSHOT_ID_PREFIX}${scope.id}_${dateKey}`,
            liabilities: deps.liabilities,
            manualValueHistory: deps.manualValueHistory,
            operationsByAsset: deps.operationsByAsset,
            scopeId: scope.id,
            scopeLabel: scope.label,
            targetDate: dateKey,
            today: dateKey,
            workspace,
          });
          if (built) {
            if (!dryRun) {
              await saveSnapshot({
                holdings: built.holdings,
                replace: false,
                snapshot: built.snapshot,
              });
            }
            created += 1;
          }
          continue;
        }

        // An existing snapshot → recalculate ONLY this asset's row, freezing the
        // historical price (overrideUnitPrice wins over cost basis). A legacy
        // capture predating holdings (ADR 0008) has no rows to recompute against —
        // leave its frozen figures untouched.
        const frozenHoldings = frozenByDate.get(dateKey) ?? [];
        if (frozenHoldings.length === 0) continue;

        const recalculated = recalculateSnapshotForAsset({
          asset,
          frozenHoldings,
          frozenIdentity,
          operations,
          overrideUnitPrice: point.unitPriceDecimal,
          snapshot: snap,
          workspace,
        });

        if (recalculated) {
          if (!dryRun) {
            await saveSnapshot({
              holdings: recalculated.holdings,
              replace: true,
              snapshot: recalculated.snapshot,
            });
          }
          updated += 1;
        }
      }
    }
  });

  return { created, updated };
}

/** Options for {@link gapFillHistoricalSnapshots}. */
interface GapFillOptions {
  /**
   * Wrap the whole fill in one transaction so a mid-run failure rolls every
   * generated snapshot back (#185). The standalone backfill sets this — it owns
   * no enclosing transaction, so without it a throw partway leaves a partially
   * filled history with no signal. The post-import path leaves it off: the
   * import already committed (ADR 0010) and the gap-fill is a best-effort
   * post-step whose failure is surfaced to the caller, not rolled back.
   */
  atomic?: boolean;
}

/**
 * Fill historical-snapshot gaps after an import (ADR 0012, Slice 3 / #112):
 * generate a snapshot for each past operation date that has no snapshot in the
 * imported file. Imported snapshots are never touched. One pass, no per-
 * operation ripple — each date is reconstructed once from all operations ≤ it.
 *
 * The standalone backfill passes `atomic` so the whole run rolls back on any
 * failure (#185); the post-import path runs best-effort and lets its caller
 * surface a thrown error instead of leaving silent partial history.
 */
export async function gapFillHistoricalSnapshots(
  ctx: StoreContext,
  workspace: Workspace,
  saveSnapshot: (input: SaveSnapshotInput) => Promise<void>,
  today: string,
  options: GapFillOptions = {},
): Promise<void> {
  const deps = await buildHistoricalSnapshotDeps(ctx.db, workspace);

  const eventDates = new Set<string>();
  for (const operations of deps.operationsByAsset.values()) {
    for (const operation of operations) {
      const dateKey = operation.executedAt.slice(0, 10);
      if (dateKey < today) eventDates.add(dateKey);
    }
  }
  const sortedDates = [...eventDates].sort();

  const fill = async (): Promise<void> => {
    for (const scope of deps.scopes) {
      const existingDates = new Set(
        (await readSnapshots(ctx.db, scope.id)).map((snap) => snap.dateKey),
      );

      for (const dateKey of sortedDates) {
        if (existingDates.has(dateKey)) continue; // imported snapshot stays intact

        const built = buildSnapshotAtDate({
          assets: deps.assets,
          capturedAt: historicalCapturedAt(dateKey),
          coinPositionsByAsset: deps.coinPositionsByAsset,
          costBasisAssetIds: deps.costBasisAssetIds,
          debtBalanceByLiability: deps.debtBalanceByLiability,
          housingValuationByAsset: deps.housingValuationByAsset,
          id: `histsnap_${scope.id}_${dateKey}`,
          liabilities: deps.liabilities,
          manualValueHistory: deps.manualValueHistory,
          operationsByAsset: deps.operationsByAsset,
          scopeId: scope.id,
          scopeLabel: scope.label,
          targetDate: dateKey,
          today,
          workspace,
        });

        if (built) {
          await saveSnapshot({
            holdings: built.holdings,
            replace: false,
            snapshot: built.snapshot,
          });
        }
      }
    }
  };

  // Atomic standalone backfill: one transaction over the whole fill, so a
  // mid-run throw rolls every generated snapshot back. saveSnapshot's nested
  // calls flatten into this outer unit, which is what survives or rolls back.
  if (options.atomic) {
    await ctx.transaction(fill);
  } else {
    await fill();
  }
}

/**
 * The snapshot-orchestration cross-cutting seams (issue #488): the two store
 * methods that span the operation ledger, the price-backfill plan, and the
 * historical-snapshot reconstruction substrate. Built as a factory so the
 * monolith can spread the result onto the public `WorthlineStore` object without
 * holding the bodies itself. Only the `snapshots` sub-store is needed — every
 * other read goes through `ctx.db` inside `buildHistoricalSnapshotDeps`.
 */
export interface SnapshotOrchestrator {
  /**
   * One-shot backfill (ADR 0012, PRD #107): generate a historical snapshot for
   * every past operation date that has no snapshot yet, across all scopes.
   * Existing snapshots are never recalculated — only gaps are filled. Idempotent.
   * `today` defaults to the current date; pass it to control the cut-off in tests.
   */
  backfillHistoricalSnapshots: (today?: string) => Promise<void>;
  /**
   * Historical-price backfill seam (#380, ADR 0033): freeze a provider's
   * historical unit prices onto ONE investment's monthly snapshots, atomically in
   * a single transaction. This is the ONLY path that rewrites historical
   * `unit_price` — explicit, auditable, never a refresh side effect. For each
   * monthly point (1st of the month from the first operation through `today`) where
   * the position existed and the source returned a price, it re-values ONLY that
   * asset's row (units × price) and preserves every OTHER frozen row verbatim
   * (ADR 0008/0012). A missing snapshot is generated; an existing one is updated in
   * place. Months without a price stay GAPS — never invented. Returns the counts,
   * the gaps, and the source used. `today` defaults to the current date.
   *
   * Pass `dryRun: true` to compute the SAME per-scope create/update counts the
   * apply would produce WITHOUT writing anything — the preview's single source of
   * truth, so the surfaced counts can never diverge from what confirm writes
   * (notably in household mode, where the asset spans multiple scopes).
   */
  backfillInvestmentPricesAndRipple: (params: {
    assetId: string;
    pricesByDate: ReadonlyMap<string, DecimalString>;
    source: string;
    today?: string;
    dryRun?: boolean;
  }) => Promise<{ created: number; updated: number; gaps: string[]; source: string }>;
}

export function createSnapshotOrchestrator(
  ctx: StoreContext,
  stores: { snapshots: SnapshotStore },
): SnapshotOrchestrator {
  return {
    backfillHistoricalSnapshots: async (today) => {
      const workspace = await ctx.getWorkspace();
      if (!workspace) return;
      // Atomic: the whole backfill is one transaction (#185), so a mid-run
      // failure rolls every generated snapshot back rather than leaving a
      // partially filled history with no signal.
      await gapFillHistoricalSnapshots(
        ctx,
        workspace,
        stores.snapshots.saveSnapshot,
        today ?? new Date().toISOString().slice(0, 10),
        { atomic: true },
      );
    },
    backfillInvestmentPricesAndRipple: ({
      assetId,
      pricesByDate,
      source,
      today: todayOpt,
      dryRun = false,
    }) => {
      const today = todayOpt ?? new Date().toISOString().slice(0, 10);
      // One transaction so the whole backfill (every create/update) commits or
      // rolls back together — the dated-fact contract (ADR 0020). The plan is
      // pure (planPriceBackfill); only the apply touches the db. A dry run runs
      // the identical scope loop (counting only) so the preview shares this one
      // code path and can never diverge from what the apply writes.
      return ctx.transaction(async () => {
        const operations = (await readAllOperations(ctx.db)).get(assetId) ?? [];
        // Dates this asset already has a snapshot on (any scope) → create vs update.
        const existingSnapshotHoldings = await readSnapshotHoldings(ctx.db, {
          holdingId: assetId,
          kind: "asset",
        });
        const existingSnapshotDates = new Set(
          existingSnapshotHoldings.map((row) => row.dateKey),
        );

        const plan = planPriceBackfill({
          existingSnapshotDates,
          operations,
          pricesByDate,
          source,
          today,
        });

        const workspace = await ctx.getWorkspace();
        if (!workspace) {
          return { created: 0, gaps: plan.gaps, source: plan.source, updated: 0 };
        }

        const { created, updated } = await rippleHistoricalSnapshotsForPriceBackfill(
          ctx,
          workspace,
          stores.snapshots.saveSnapshot,
          {
            assetId,
            dryRun,
            points: plan.points.map((p) => ({
              dateKey: p.dateKey,
              unitPriceDecimal: p.unitPriceDecimal,
            })),
          },
        );

        return { created, gaps: plan.gaps, source: plan.source, updated };
      });
    },
  };
}
