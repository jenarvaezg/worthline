import type { BinanceHistoryCurve, CoinPosition, Workspace } from "@worthline/domain";
import {
  binanceCurveStartDate,
  binanceValueAtDate,
  buildSnapshotAtDate,
  carryForwardTokenUnitPrices,
  coinPositionSnapshotInput,
  coinValue,
  completedMonthEndDates,
  createNetWorthSnapshot,
  historicalCapturedAt,
  listScopeOptions,
  recalculateSnapshotForCoinAcquisition,
  recalculateSnapshotForConnectedValue,
} from "@worthline/domain";

import {
  type ConnectedSourceStore,
  type SourcePositionInput,
} from "./connected-source-store";
import {
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
import { type StoreContext } from "./store-context";

/**
 * Ripple newly-mirrored coin purchase dates into snapshot history (ADR 0017, S6
 * / #167). Unlike the operation/curve ripples — which RE-DERIVE one holding's
 * whole value from its ledger on each affected date — a coin acquisition is
 * ADDITIVE and ONE-SHOT: each new trade's value is captured at this sync and
 * added to the coin-collection row of every existing snapshot dated on/after its
 * purchase date. A trade already mirrored on a prior sync is never passed here
 * again, so a later price move never rewrites a past snapshot (frozen), and a
 * sold trade is never subtracted, so it stays in the snapshots it was rippled
 * into while leaving the live holding. No new snapshot dates are generated — only
 * existing snapshots are touched (the literal S6 scope).
 *
 * For each scope/snapshot the per-snapshot delta is the SUM of every new trade
 * acquired on/before that date, applied in a single recalculation so the row and
 * the five figures reconcile in one pass (ADR 0008). Legacy captures with no
 * holding rows are skipped, like the sibling ripples.
 */
async function rippleHistoricalSnapshotsForCoinAcquisition(
  ctx: StoreContext,
  workspace: Workspace,
  saveSnapshot: (input: SaveSnapshotInput) => Promise<void>,
  params: { assetId: string; newTrades: readonly CoinPosition[] },
): Promise<void> {
  const { db } = ctx;

  // The coin-collection holding's identity (ownership, illiquid tier) — read
  // including trashed, since it existed on the snapshot dates regardless.
  const asset = await readInvestmentIdentity(db, params.assetId);
  if (!asset) return;

  // The collection's frozen classification captures across every snapshot (#242),
  // read ONCE before any recalc mutates rows (see rippleHistoricalSnapshots).
  const frozenIdentity = await readFrozenIdentityCaptures(db, params.assetId, "asset");

  // Each new trade reduced to its frozen GLOBAL value + the date it enters the
  // timeline. A zero-value coin adds nothing, so it never forces a recalculation.
  const trades = params.newTrades
    .filter((position) => position.purchaseDate !== null)
    .map((position) => ({
      purchaseDate: position.purchaseDate as string,
      valueMinor: coinValue(position).minor,
      position: coinPositionSnapshotInput(position),
    }))
    .filter((trade) => trade.valueMinor > 0);
  if (trades.length === 0) return;

  for (const scope of listScopeOptions(workspace)) {
    for (const snap of await readSnapshots(db, scope.id)) {
      // The combined value of every new coin acquired on/before this snapshot —
      // each trade ripples only from its OWN purchase date forward.
      const qualifying = trades.filter((trade) => trade.purchaseDate <= snap.dateKey);
      const globalDeltaMinor = qualifying.reduce(
        (sum, trade) => sum + trade.valueMinor,
        0,
      );
      if (globalDeltaMinor === 0) continue;

      const frozenHoldings = await readSnapshotHoldings(db, {
        from: snap.dateKey,
        scopeId: scope.id,
        to: snap.dateKey,
      });
      // A legacy capture predating holdings (ADR 0008) has nothing to recompute.
      if (frozenHoldings.length === 0) continue;

      const recalculated = recalculateSnapshotForCoinAcquisition({
        asset,
        frozenHoldings,
        frozenIdentity,
        globalDeltaMinor,
        newTrades: qualifying,
        snapshot: snap,
        workspace,
      });

      if (recalculated) {
        await saveSnapshot({
          holdings: recalculated.holdings,
          replace: true,
          snapshot: recalculated.snapshot,
        });
      }
    }
  }
}

/**
 * Backfill a connected Binance source's monthly value history into snapshots
 * (PRD #245 S5 / #250, ADR 0021). The reconstructed `BinanceHistoryCurve` is
 * valued at every completed month-end (and every existing snapshot in the curve's
 * window) and the result is FROZEN into the market holding's row — SET, not
 * additive — generating the base whole-portfolio snapshot when none exists.
 * Append-only/frozen: a date whose snapshot already carries the binance row is
 * left exactly as captured (a re-sync only adds newly-completed months).
 *
 * Atomic (one transaction). A null curve start is a no-op. Binance only — no
 * coins/Numista interaction.
 */
async function backfillBinanceHistoricalSnapshots(
  ctx: StoreContext,
  workspace: Workspace,
  saveSnapshot: (input: SaveSnapshotInput) => Promise<void>,
  params: { assetId: string; curve: BinanceHistoryCurve; today: string },
): Promise<void> {
  const { db } = ctx;
  const { assetId, curve, today } = params;

  // The market asset's identity — read including trashed, since it existed on the
  // snapshot dates regardless (ADR 0012).
  const asset = await readInvestmentIdentity(db, assetId);
  if (!asset) return;

  // The curve's earliest valuable date; below it nothing is valued (ADR 0021).
  const start = binanceCurveStartDate(curve);
  if (start === null) return;

  // The asset's frozen classification captures across every snapshot (#242), read
  // ONCE before any recalc mutates rows (see rippleHistoricalSnapshots).
  const frozenIdentity = await readFrozenIdentityCaptures(db, assetId, "asset");

  // Every completed month-end (never the current partial month) — the same anchors
  // across every scope (the curve is portfolio-wide). Built once.
  const monthEnds = completedMonthEndDates(curve, today);

  // Build deps once — the same for every scope (lesson from #114).
  const deps = await buildHistoricalSnapshotDeps(db, workspace);

  await ctx.transaction(async () => {
    for (const scope of listScopeOptions(workspace)) {
      const existing = await readSnapshots(db, scope.id);
      const existingByDate = new Map(existing.map((snap) => [snap.dateKey, snap]));

      // Affected dates = the UNION of the completed month-ends and every existing
      // snapshot date in [start, today) — ascending, deduped. An existing snapshot
      // in the window gets the binance value added even if it is not a month-end.
      // Month-ends are lower-bounded by `start` too: a month-end below the curve's
      // first valuable day values to 0, so anchoring there would only materialize a
      // spurious zero-valued snapshot and drag the UI's "Datos desde" before the
      // real curve start (#250 review).
      const affected = new Set<string>(monthEnds.filter((d) => d >= start && d < today));
      for (const snap of existing) {
        if (snap.dateKey >= start && snap.dateKey < today) affected.add(snap.dateKey);
      }
      const dates = [...affected].sort();

      // Read the scope's frozen rows for the whole [start, today) band in ONE
      // batched query (#205), grouped by date in memory (one read per scope).
      const frozenByDate = groupFrozenHoldingsByDate(
        await readSnapshotHoldings(db, { scopeId: scope.id, from: start }),
      );

      for (const dateKey of dates) {
        const frozenHoldings = frozenByDate.get(dateKey) ?? [];

        // Append-only/frozen: a date whose snapshot already carries the binance
        // asset's frozen row is left exactly as captured (never rewritten).
        const alreadyHasBinanceRow = frozenHoldings.some(
          (row) => row.holdingId === assetId && row.kind === "asset",
        );
        if (alreadyHasBinanceRow) continue;

        const valueMinor = binanceValueAtDate(curve, dateKey);
        const snap = existingByDate.get(dateKey);

        if (snap !== undefined) {
          // An existing snapshot at this date → SET the binance row to the
          // reconstructed value. A legacy capture predating holdings (ADR 0008)
          // has nothing to reconcile against — leave it frozen.
          if (frozenHoldings.length === 0) continue;
          const recalculated = recalculateSnapshotForConnectedValue({
            asset,
            frozenHoldings,
            frozenIdentity,
            globalValueMinor: valueMinor,
            snapshot: snap,
            workspace,
          });
          if (recalculated) {
            await saveSnapshot({
              holdings: recalculated.holdings,
              replace: true,
              snapshot: recalculated.snapshot,
            });
          }
          continue;
        }

        // No snapshot at this date → generate the base whole-portfolio snapshot
        // (mirror the `rippleHistoricalSnapshots` generate branch), then OVERRIDE
        // its binance row to the reconstructed value: the base values the holding
        // at its stored/live basis (wrong for the past) — the SET corrects it.
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

        // The base built nothing AND the binance value is 0 → an entirely empty
        // snapshot. Skip it (the portfolio held nothing valuable that day).
        if (!built && valueMinor === 0) continue;

        const base = built ?? {
          holdings: [],
          snapshot: createNetWorthSnapshot({
            capturedAt: historicalCapturedAt(dateKey),
            id: `histsnap_${scope.id}_${dateKey}`,
            isMonthlyClose: false,
            scopeId: scope.id,
            scopeLabel: scope.label,
            summary: {
              debts: { amountMinor: 0, currency: workspace.baseCurrency },
              grossAssets: { amountMinor: 0, currency: workspace.baseCurrency },
              housingEquity: { amountMinor: 0, currency: workspace.baseCurrency },
              liquidNetWorth: { amountMinor: 0, currency: workspace.baseCurrency },
              scopeId: scope.id,
              totalNetWorth: { amountMinor: 0, currency: workspace.baseCurrency },
            },
            warnings: [],
          }),
        };

        const overridden = recalculateSnapshotForConnectedValue({
          asset,
          frozenHoldings: base.holdings,
          frozenIdentity,
          globalValueMinor: valueMinor,
          snapshot: base.snapshot,
          workspace,
        });
        if (overridden) {
          await saveSnapshot({
            holdings: overridden.holdings,
            replace: false,
            snapshot: overridden.snapshot,
          });
        }
      }
    }

    await ctx.writeAuditEntry("backfill_binance_history", "asset", assetId, {
      monthEnds: monthEnds.length,
      start,
    });
  });
}

/**
 * The connected-source cross-cutting seams (issue #487): the two store methods
 * that span the connected-source store, the snapshot store, and the historical
 * ripple substrate. Built as a factory so the monolith can spread the result onto
 * the public `WorthlineStore` object without holding the bodies itself.
 */
export interface ConnectedSourceSeams {
  /**
   * Mirror a connected source's latest positions, then ripple the dated facts of
   * any genuinely-new coin acquisition into the historical snapshots (ADR 0017,
   * #167). A trade carrying a purchase date freezes that coin's GLOBAL value into
   * every existing snapshot dated on/after that purchase date. A position already
   * seen on a prior sync is never rippled again (so a later price move never
   * rewrites a past snapshot), and a position that disappeared (sold on Numista)
   * simply leaves the live holding while its value stays frozen in the snapshots
   * it was already rippled into. A coin with no purchase date has no dated fact
   * and is not rippled (it counts only in the live holding and snapshots captured
   * from now on).
   */
  syncConnectedSource: (params: {
    sourceId: string;
    positions: SourcePositionInput[];
    syncedAt: string;
  }) => Promise<void>;
  /**
   * Backfill a connected Binance source's monthly value history into snapshots
   * (PRD #245 S5 / #250, ADR 0021). Values the reconstructed `BinanceHistoryCurve`
   * (balance step-function × that-day historical price) at every completed
   * month-end and every existing snapshot in the curve's window, FREEZING the
   * result into the market holding's row (SET, not additive). Append-only: a date
   * whose snapshot already carries the binance row is skipped (a re-sync only adds
   * newly-completed months, never rewrites a past value). A null curve start is a
   * no-op. `today` defaults to the current date; pass it to control the cut-off.
   */
  applyBinanceHistoryAndRipple: (params: {
    sourceId: string;
    curve: BinanceHistoryCurve;
    today?: string;
  }) => Promise<void>;
}

export function createConnectedSourceSeams(
  ctx: StoreContext,
  stores: { connectedSources: ConnectedSourceStore; snapshots: SnapshotStore },
): ConnectedSourceSeams {
  return {
    syncConnectedSource: async (params) => {
      const workspace = await ctx.getWorkspace();
      // One transaction so the wholesale replace + every coin ripple commit or
      // roll back together.
      await ctx.transaction(async () => {
        // Read the prior positions ONCE: they seed both the new-coin diff below AND
        // the token price carry-forward — the wholesale replace reassigns ids, so
        // this must run first.
        const previousPositions = await stores.connectedSources.readPositions(
          params.sourceId,
        );

        // Diff BEFORE the wholesale replace: the set of external ids already
        // mirrored — the coins already on the timeline.
        const knownExternalIds = new Set(
          previousPositions.map((position) => position.externalId),
        );

        // A token this sync could not price arrives with unitPrice null, which would
        // value it 0 — silently zeroing a balance the account still holds on a single
        // transient price miss (the WBETH-vanished bug). Carry each token's last-good
        // price forward so a valued holding is never zeroed by a one-off CoinGecko
        // miss; it self-heals on the next clean price.
        const positions = carryForwardTokenUnitPrices(
          params.positions,
          previousPositions,
        );

        await stores.connectedSources.syncPositions(
          params.sourceId,
          positions,
          params.syncedAt,
        );

        if (!workspace) return; // no workspace → no scopes, no history to ripple

        const source = await stores.connectedSources.readSource(params.sourceId);
        if (!source) return;

        // A genuinely new trade carrying a purchase date is the only dated fact to
        // ripple (ADR 0017): a coin seen before is frozen, a coin with no date has
        // no past fact (it counts from the live holding forward).
        const newDatedTrades = (
          await stores.connectedSources.readPositions(params.sourceId)
        ).filter(
          (position): position is CoinPosition =>
            position.kind === "coin" &&
            !knownExternalIds.has(position.externalId) &&
            position.purchaseDate !== null,
        );
        if (newDatedTrades.length === 0) return;

        await rippleHistoricalSnapshotsForCoinAcquisition(
          ctx,
          workspace,
          stores.snapshots.saveSnapshot,
          { assetId: source.assetId, newTrades: newDatedTrades },
        );
      });
    },
    applyBinanceHistoryAndRipple: async (params) => {
      const workspace = await ctx.getWorkspace();
      if (!workspace) return; // no workspace → no scopes, no history to backfill

      const source = await stores.connectedSources.readSource(params.sourceId);
      if (!source) return;

      await backfillBinanceHistoricalSnapshots(
        ctx,
        workspace,
        stores.snapshots.saveSnapshot,
        {
          assetId: source.assetId,
          curve: params.curve,
          today: params.today ?? new Date().toISOString().slice(0, 10),
        },
      );
    },
  };
}
