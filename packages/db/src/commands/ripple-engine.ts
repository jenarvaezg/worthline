import type { AssetStore } from "@db/asset-store";
import {
  buildHistoricalSnapshotDeps,
  groupFrozenHoldingsByDate,
  type HistoricalSnapshotDeps,
  readFrozenIdentityCaptures,
  readInvestmentIdentity,
  readLiabilityIdentity,
} from "@db/historical-snapshot-deps";
import { readAllOperations } from "@db/operation-reads";
import {
  readSnapshotHoldings,
  readSnapshots,
  type SaveSnapshotInput,
  type SnapshotHoldingRecord,
  type SnapshotStore,
} from "@db/snapshot-store";
import type { StoreContext } from "@db/store-context";
import type {
  FrozenIdentityCapture,
  HousingValuationAnchor,
  InvestmentOperation,
  Liability,
  ManualAsset,
  NetWorthSnapshot,
  OwnershipShare,
  ValuedNetWorthSnapshot,
  Workspace,
} from "@worthline/domain";
import {
  globalHoldingValueAtDate,
  housingAssetIdsOf,
  isHousingAsset,
  rebaselineChainPaymentDatesUpTo,
  recalculateSnapshotForAsset,
  recalculateSnapshotForHousing,
  recalculateSnapshotForLiability,
  recalculateSnapshotForOwnership,
  resolveScopeMemberIds,
} from "@worthline/domain";
import { eq } from "drizzle-orm";

import {
  EMPTY_RIPPLE_BAND_COUNTS,
  type RippleBandCounts,
  rippleBand,
} from "./ripple-band";

// ── Historical snapshots ripple engine (ADR 0012, PRD #107) ──────────────────
//
// One band, one command per family. `rippleBand` (./ripple-band) owns the walk
// every dated-fact family shares — generate at the event dates, recalculate
// forward from a floor, prune the orphans; each function here is the thin command
// that tells it WHICH identities, WHICH dates, and HOW one snapshot's rows are
// rewritten (ADR 0089). Investments, the mixed import, housing and ownership live
// here; the debt family, whose dates come off the live curve, lives in
// `./debt-band`. The per-family command factories (`investment-operations`,
// `valuation-facts`, `ownership-facts`, `debt-balance-facts`, `debt-plan-facts`,
// `statement-import`) import from here; they never depend on one another. The
// reader primitives and the `buildHistoricalSnapshotDeps` aggregator live in
// `./historical-snapshot-deps` (the neutral shared substrate the ripple/seam
// modules import, keeping the dependency graph acyclic).

/** One investment asset a band re-folds, with everything its rewrite needs read
 *  up front: identity (including trashed — it existed on the snapshot dates),
 *  full ledger, and frozen classification captures (#242). */
interface OperatedAsset {
  asset: ManualAsset;
  frozenIdentity: FrozenIdentityCapture[];
  operations: InvestmentOperation[];
}

/**
 * Re-fold every operated asset's row through one snapshot, in memory. Each asset
 * recalculates against the previous fold's snapshot + rows — the state a
 * per-asset ripple would have re-read from the DB — so the band persists the
 * snapshot ONCE at the end instead of once per asset. Null as soon as an asset's
 * recalculation leaves no holdings: the snapshot is dropped.
 */
function foldOperatedAssets(
  affected: ReadonlyArray<OperatedAsset>,
  workspace: Workspace,
  input: { snapshot: NetWorthSnapshot; frozenHoldings: SnapshotHoldingRecord[] },
): ValuedNetWorthSnapshot | null {
  let current: ValuedNetWorthSnapshot = {
    holdings: input.frozenHoldings,
    snapshot: input.snapshot,
  };
  for (const { asset, frozenIdentity, operations } of affected) {
    const recalculated = recalculateSnapshotForAsset({
      asset,
      frozenHoldings: current.holdings,
      frozenIdentity,
      operations,
      snapshot: current.snapshot,
      workspace,
    });
    if (recalculated === null) return null;
    current = recalculated;
  }
  return current;
}

/**
 * Batched ripple for operation loads/deletes (ADR 0018, #174, #753). Record mode
 * generates a fresh whole-portfolio snapshot at each affected past operation date
 * that has none yet; both modes then run ONE forward recalculation of every
 * existing snapshot dated ≥ the earliest affected date, re-evaluating only the
 * operated assets' rows.
 *
 * One band per load, never one per operation (which would re-derive history N
 * times — the #158 O(N×snapshots) cliff): deps are built once, the frozen rows
 * are read in one batched query per scope, and a single forward pass folds every
 * affected asset across the band regardless of how many operation dates the load
 * carried. Multi-asset for the same reason: a multi-ISIN statement import (ADR
 * 0055) rippling once per fund re-wrote every snapshot in the band once per fund
 * — thousands of saveSnapshots that, at hosted network latency (one libsql round
 * trip per statement), blew past the serverless 300s ceiling. Folding all funds
 * in memory persists each snapshot exactly once.
 *
 * - record(D), D in the past: generate the snapshot at D if none exists (the new
 *   operation supplies its own best price), and recalculate every existing
 *   snapshot dated ≥ D. The affected range is ≥ D, not > D: an existing snapshot
 *   at D is overwritten in place, not skipped.
 * - delete(D): recalculate existing snapshots dated ≥ D (the snapshot at D was
 *   itself derived from the operation that just disappeared). A backfilled
 *   snapshot whose date no dated fact justifies any more is pruned outright,
 *   frozen rows and all, for every scope (#305) — a daily capture never is.
 *
 * Dates today or in the future generate no history (the daily capture owns today
 * and the future is not history). Recalculations honor the unit price each
 * snapshot already captured for an asset; only an asset absent from a snapshot
 * falls back to the last known operation price ≤ its date. Legacy captures with
 * no holding rows are skipped (ADR 0008). Unknown assets and empty date lists are
 * skipped; a no-op when nothing remains.
 */
export async function rippleHistoricalSnapshotsForOperations(
  ctx: StoreContext,
  workspace: Workspace,
  saveSnapshot: (input: SaveSnapshotInput) => Promise<void>,
  params: {
    assets: ReadonlyArray<{ assetId: string; operationDateKeys: string[] }>;
    mode?: "record" | "delete";
    today: string;
  },
): Promise<void> {
  const { db } = ctx;
  const { mode = "record", today } = params;
  const requested = params.assets.filter((a) => a.operationDateKeys.length > 0);
  if (requested.length === 0) return;

  // Every affected asset's identity, ledger and frozen captures — all read ONCE
  // before any recalc mutates rows.
  const operationsByAsset = await readAllOperations(db);
  const affected = (
    await Promise.all(
      requested.map(async ({ assetId, operationDateKeys }) => {
        const asset = await readInvestmentIdentity(db, assetId);
        if (!asset) return null;
        return {
          asset,
          frozenIdentity: await readFrozenIdentityCaptures(db, assetId, "asset"),
          operationDateKeys,
          operations: operationsByAsset.get(assetId) ?? [],
        };
      }),
    )
  ).filter((entry) => entry !== null);
  if (affected.length === 0) return;

  // Unique affected dates across every asset, and the earliest from which
  // existing snapshots recalc.
  const eventDates = [...new Set(affected.flatMap((a) => a.operationDateKeys))];
  const recalcFrom = eventDates.reduce(
    (min, date) => (date < min ? date : min),
    eventDates[0]!,
  );

  await rippleBand(ctx, workspace, saveSnapshot, {
    // Deletes never generate, so they need no whole-portfolio deps at all — and
    // neither does the commonest record: an operation dated today mints nothing
    // (the daily capture owns today), so the band never awaits this thunk. When
    // it does, it awaits it once for every scope (lesson from #114).
    ...(mode === "record"
      ? {
          generate: {
            dates: eventDates,
            deps: () => buildHistoricalSnapshotDeps(db, workspace),
            today,
          },
        }
      : {}),
    // Deleting ONE operation at date D can only newly-orphan date D ITSELF —
    // every other date keeps its own independent justification (#305, PR #326).
    ...(mode === "delete" ? { pruneDates: new Set(eventDates) } : {}),
    recalcFrom,
    rewrite: (input) => foldOperatedAssets(affected, workspace, input),
  });
}

/**
 * One-pass ripple for a mixed historical import (ADR 0059, #770). All facts are
 * persisted before this runs. Dependencies and frozen rows are read once, every
 * affected domain is folded in memory, and each snapshot is saved at most once.
 */
export async function rippleHistoricalSnapshotsForMixedImport(
  ctx: StoreContext,
  workspace: Workspace,
  saveSnapshot: (input: SaveSnapshotInput) => Promise<void>,
  params: {
    investments: ReadonlyArray<{ assetId: string; dateKeys: string[] }>;
    debts: ReadonlyArray<{ liabilityId: string; fromDateKey: string }>;
    housing: ReadonlyArray<{ assetId: string; fromDateKey: string }>;
    today: string;
  },
): Promise<void> {
  const requestedDates = [
    ...params.investments.flatMap(({ dateKeys }) => dateKeys),
    ...params.debts.map(({ fromDateKey }) => fromDateKey),
    ...params.housing.map(({ fromDateKey }) => fromDateKey),
  ];
  if (requestedDates.length === 0) return;

  const { db } = ctx;
  const deps = await buildHistoricalSnapshotDeps(db, workspace);
  const investments = (
    await Promise.all(
      params.investments.map(async ({ assetId, dateKeys }) => {
        const asset = await readInvestmentIdentity(db, assetId);
        if (!asset || dateKeys.length === 0) return null;
        return {
          asset,
          dateKeys,
          frozenIdentity: await readFrozenIdentityCaptures(db, assetId, "asset"),
          // The asset appears in the band from its earliest imported order on.
          fromDateKey: dateKeys.reduce(
            (min, date) => (date < min ? date : min),
            dateKeys[0]!,
          ),
          operations: deps.operationsByAsset.get(assetId) ?? [],
        };
      }),
    )
  ).filter((entry) => entry !== null);
  const housing = (
    await Promise.all(
      params.housing.map(async ({ assetId, fromDateKey }) => {
        const asset = await readInvestmentIdentity(db, assetId);
        const curve = deps.housingValuationByAsset.get(assetId);
        if (!asset || !isHousingAsset(asset) || !curve) return null;
        return {
          asset,
          curve,
          fromDateKey,
          frozenIdentity: await readFrozenIdentityCaptures(db, assetId, "asset"),
        };
      }),
    )
  ).filter((entry) => entry !== null);
  const debts = (
    await Promise.all(
      params.debts.map(async ({ liabilityId, fromDateKey }) => {
        const liability = await readLiabilityIdentity(db, liabilityId);
        const curve = deps.debtBalanceByLiability.get(liabilityId);
        if (!liability || !curve || curve.debtModel === null) return null;
        return { curve, fromDateKey, liability };
      }),
    )
  ).filter((entry) => entry !== null);

  const eventDates = new Set<string>();
  for (const { dateKeys } of investments) {
    for (const dateKey of dateKeys) eventDates.add(dateKey);
  }
  for (const { fromDateKey } of housing) eventDates.add(fromDateKey);
  for (const { curve, fromDateKey } of debts) {
    for (const dateKey of rebaselineChainPaymentDatesUpTo(
      curve.balanceRebaselines ?? [],
      fromDateKey,
      params.today,
    )) {
      eventDates.add(dateKey);
    }
  }
  const recalcFrom = [...eventDates, ...requestedDates].reduce((min, date) =>
    date < min ? date : min,
  );
  const housingAssetIds = housingAssetIdsOf(deps.assets);

  await rippleBand(ctx, workspace, saveSnapshot, {
    generate: { dates: [...eventDates], deps: async () => deps, today: params.today },
    recalcFrom,
    rewrite: ({ frozenHoldings, snapshot }) => {
      // Each domain enters the fold only from its own affected date on; the row
      // it rewrites lands back on the previous domain's output, so the band
      // persists the snapshot once for the whole import.
      let current: ValuedNetWorthSnapshot | null = {
        holdings: frozenHoldings,
        snapshot,
      };
      for (const investment of investments) {
        if (current === null) break;
        if (snapshot.dateKey < investment.fromDateKey) continue;
        current = recalculateSnapshotForAsset({
          asset: investment.asset,
          frozenHoldings: current.holdings,
          frozenIdentity: investment.frozenIdentity,
          operations: investment.operations,
          snapshot: current.snapshot,
          workspace,
        });
      }
      for (const item of housing) {
        if (current === null) break;
        if (snapshot.dateKey < item.fromDateKey) continue;
        current = recalculateSnapshotForHousing({
          asset: item.asset,
          curve: item.curve,
          frozenHoldings: current.holdings,
          frozenIdentity: item.frozenIdentity,
          manualValueHistory: deps.manualValueHistory,
          snapshot: current.snapshot,
          today: params.today,
          workspace,
        });
      }
      for (const item of debts) {
        if (current === null) break;
        if (snapshot.dateKey < item.fromDateKey) continue;
        current = recalculateSnapshotForLiability({
          curve: item.curve,
          frozenHoldings: current.holdings,
          housingAssetIds,
          liability: item.liability,
          snapshot: current.snapshot,
          workspace,
        });
      }
      return current;
    },
  });
}

/**
 * Ripple effect for housing valuation curves (PRD #108): declaring, editing, or
 * deleting a valuation anchor — or changing the appreciation rate — regenerates
 * the snapshot at the change date and recalculates the existing snapshots it
 * affects.
 *
 * - `fromDateKey` in the past: generate the snapshot at that date (valuing the
 *   housing asset from its now-current curve), then recalculate every existing
 *   snapshot dated ≥ fromDateKey by re-evaluating only the housing asset's row
 *   from the curve.
 * - For a rate change, pass the first anchor's date as `fromDateKey` so every
 *   snapshot after it is recalculated (the rate only affects extrapolation
 *   before the first / after the last appraisal).
 * - `fromDateKey` today or in the future never generates history — the daily
 *   capture owns today and the future is not history. Future anchors thus
 *   produce no snapshot.
 *
 * Only the housing asset's row in each snapshot is recomputed; every other
 * frozen row is preserved, and legacy captures with no holding rows are skipped.
 *
 * With `dryRun`, the same walk runs and NOTHING is persisted — the counts come
 * back so a preview can say how much history a curve edit rewrites before it is
 * written (#1562), measured by the engine that writes it (#1438). A dry run of an
 * edit that is not stored yet passes `anchors`: the band then values the curve
 * with the anchors the edit WOULD write, which is what decides whether a fresh
 * snapshot appears at the new from-date (a property does not exist in history
 * before its first appraisal).
 */
export async function rippleHistoricalSnapshotsForValuation(
  ctx: StoreContext,
  workspace: Workspace,
  saveSnapshot: (input: SaveSnapshotInput) => Promise<void>,
  params: {
    assetId: string;
    fromDateKey: string;
    today: string;
    /** Count only — never persist (the preview's dry run, #1562). */
    dryRun?: boolean;
    /**
     * Value the asset's curve with THESE anchors instead of the stored ones — how
     * a dry run asks "what would this edit do" before the edit exists (#1562).
     */
    anchors?: readonly HousingValuationAnchor[];
  },
): Promise<RippleBandCounts> {
  const { db } = ctx;
  const { assetId, dryRun = false, fromDateKey, today } = params;

  // The housing asset's identity — read including trashed, since it existed on
  // the snapshot dates even if it was trashed afterwards.
  const asset = await readInvestmentIdentity(db, assetId);
  if (!asset || !isHousingAsset(asset)) return EMPTY_RIPPLE_BAND_COUNTS;

  // Build deps once — they are the same for every scope (lesson from #114).
  const deps = await buildHistoricalSnapshotDeps(db, workspace);
  const stored = deps.housingValuationByAsset.get(assetId);
  // No map entry means the asset is not housing or has been trashed with no
  // remaining live record — nothing to ripple.
  if (!stored) return EMPTY_RIPPLE_BAND_COUNTS;

  // The anchors the caller asks about, in BOTH halves of the band: the generation
  // of a missing date reads them off `deps`, the rewrite off `curve`. Overriding
  // one and not the other is how a preview starts disagreeing with its write.
  // A new map, not a write into the one `buildHistoricalSnapshotDeps` returned.
  const curve =
    params.anchors !== undefined ? { ...stored, anchors: params.anchors } : stored;
  const effectiveDeps =
    curve === stored
      ? deps
      : {
          ...deps,
          housingValuationByAsset: new Map(deps.housingValuationByAsset).set(
            assetId,
            curve,
          ),
        };

  // The asset's frozen classification captures across every snapshot (#242), read
  // ONCE before any recalc mutates rows.
  const frozenIdentity = await readFrozenIdentityCaptures(db, assetId, "asset");

  return rippleBand(ctx, workspace, saveSnapshot, {
    dryRun,
    generate: { dates: [fromDateKey], deps: async () => effectiveDeps, today },
    recalcFrom: fromDateKey,
    // Re-evaluate only the housing asset's row from the curve (or its
    // last-known value when the curve is now empty).
    rewrite: ({ frozenHoldings, snapshot }) =>
      recalculateSnapshotForHousing({
        asset,
        curve,
        frozenHoldings,
        frozenIdentity,
        manualValueHistory: effectiveDeps.manualValueHistory,
        snapshot,
        today,
        workspace,
      }),
  });
}

/**
 * Re-derive one asset's GLOBAL (100%) value on a date from the lossless deps,
 * honoring the frozen household row's captured unit price / cost-basis flag so an
 * investment's re-valued global matches the price the snapshot showed (#187).
 */
function globalAssetValue(
  asset: ManualAsset,
  deps: HistoricalSnapshotDeps,
  householdRow: SnapshotHoldingRecord,
  dateKey: string,
): number | null {
  const housingCurve = deps.housingValuationByAsset.get(asset.id);
  const manualValueHistory = deps.manualValueHistory.get(asset.id);
  return globalHoldingValueAtDate(
    {
      atCostBasis:
        householdRow.units !== undefined && householdRow.unitPrice === undefined,
      holding: { asset, kind: "asset" },
      operations: deps.operationsByAsset.get(asset.id) ?? [],
      ...(householdRow.unitPrice !== undefined
        ? { capturedUnitPrice: householdRow.unitPrice }
        : {}),
      ...(housingCurve !== undefined ? { housingCurve } : {}),
      ...(manualValueHistory !== undefined ? { manualValueHistory } : {}),
    },
    dateKey,
  );
}

/** Re-derive one liability's GLOBAL (100%) outstanding balance on a date (#187). */
function globalLiabilityValue(
  liability: Liability,
  deps: HistoricalSnapshotDeps,
  dateKey: string,
): number | null {
  const debtCurve = deps.debtBalanceByLiability.get(liability.id);
  const manualValueHistory = deps.manualValueHistory.get(liability.id);
  return globalHoldingValueAtDate(
    {
      holding: { kind: "liability", liability },
      ...(debtCurve !== undefined ? { debtCurve } : {}),
      ...(manualValueHistory !== undefined ? { manualValueHistory } : {}),
    },
    dateKey,
  );
}

/**
 * Ripple effect for an ownership-split edit (#172): re-weight the edited
 * holding's row in every existing scope snapshot using its new split. Unlike the
 * value bands this generates NO snapshot dates — an ownership split has no date
 * dimension, which is why it hands the band no `generate` and a null floor: the
 * dates it touches are decided row by row. The whole-holding (global, 100%) value
 * at each date is RE-DERIVED losslessly from the holding's curve / operations /
 * stored basis — the same source `buildSnapshotAtDate` values it from (#187) —
 * never recovered by dividing the rounded household snapshot row, which cannot
 * invert allocation rounding and drifts ±1–2 minor units for a holding co-owned
 * with a non-member (the household combined share < 100%). The set of dates
 * re-weighted is exactly the household snapshots that carry the holding (an
 * ownership edit moves no other dates). Every scope — including the household —
 * is then re-weighted from that global value, so a holding fully owned within the
 * household leaves the household figure unchanged while a co-owned holding's
 * household figure moves with the members' combined share. Only the edited
 * holding's row moves; every other frozen row is preserved, the reconciliation
 * invariant holds (ADR 0008), and legacy captures with no holding rows are
 * skipped. A no-op when the household held no stake before, or no household
 * snapshot carries the holding.
 */
export async function rippleHistoricalSnapshotsForOwnership(
  ctx: StoreContext,
  workspace: Workspace,
  saveSnapshot: (input: SaveSnapshotInput) => Promise<void>,
  params: {
    holdingId: string;
    kind: "asset" | "liability";
    previousOwnership: OwnershipShare[];
  },
): Promise<void> {
  const { db } = ctx;
  const { holdingId, kind, previousOwnership } = params;

  // The edited holding's identity, carrying its NEW ownership split — read
  // including trashed, since it existed on the snapshot dates regardless.
  const asset = kind === "asset" ? await readInvestmentIdentity(db, holdingId) : null;
  const liability =
    kind === "liability" ? await readLiabilityIdentity(db, holdingId) : null;
  if (!asset && !liability) return;

  // The combined stake the household held under the PREVIOUS split. Zero means the
  // household held nothing before this edit → nothing to re-weight, no-op.
  const householdMemberIds = new Set(resolveScopeMemberIds(workspace, "household"));
  const previousHouseholdBps = previousOwnership
    .filter((share) => householdMemberIds.has(share.memberId))
    .reduce((sum, share) => sum + share.shareBps, 0);
  if (previousHouseholdBps <= 0) return;

  // The valuation deps `buildSnapshotAtDate` uses (operations, curves, manual
  // history): the lossless source the global value is RE-DERIVED from (#187),
  // never the rounded household row.
  const deps = await buildHistoricalSnapshotDeps(db, workspace);
  // A liability that secures the home nets housing equity (ADR 0013).
  const housingAssetIds =
    liability !== null ? housingAssetIdsOf(deps.assets) : new Set<string>();

  // The holding's frozen classification captures across every snapshot (#242),
  // read ONCE before any recalc mutates rows. A member gaining a stake gets a
  // brand-new row whose frozen housing-ness/tier the seam recovers from these
  // captures (e.g. the household scope's), not from the live identity.
  const frozenIdentity = await readFrozenIdentityCaptures(db, holdingId, kind);

  // The dates to re-weight: exactly the household snapshots carrying the holding,
  // each mapped to the LOSSLESS global value re-derived from the holding's curve /
  // operations / stored basis. The household row's frozen unit price /
  // cost-basis flag is honored so an investment's re-valued global matches the
  // price the snapshot captured. One batched household read of THIS holding
  // (#1533), not one query per snapshot; passing holdingId skips the second
  // positions read (those serve the connected-coin drilldown, never this
  // re-weight).
  const globalByDate = new Map<string, number>();
  const householdFrozenByDate = groupFrozenHoldingsByDate(
    await readSnapshotHoldings(db, { holdingId, kind, scopeId: "household" }),
  );
  for (const snap of await readSnapshots(db, "household")) {
    const row = (householdFrozenByDate.get(snap.dateKey) ?? []).find(
      (r) => r.holdingId === holdingId && r.kind === kind,
    );
    if (!row) continue;

    const globalValueMinor = asset
      ? globalAssetValue(asset, deps, row, snap.dateKey)
      : globalLiabilityValue(liability!, deps, snap.dateKey);
    // A household row exists for this date, so the holding WAS captured then.
    // Re-valuation returns null only when the live ledger no longer holds it on
    // that date (e.g. operations deleted since the freeze) — a data mismatch the
    // frozen row alone records faithfully. SKIP re-weighting that date: dividing
    // the already-allocated household row back to a global would re-introduce the
    // lossy-magnitude error #187 removed (#212). Leaving the date out of
    // globalByDate makes the rewrite leave the frozen row untouched as the only
    // faithful record of that date.
    if (globalValueMinor !== null) {
      globalByDate.set(snap.dateKey, globalValueMinor);
    }
  }
  if (globalByDate.size === 0) return; // no household basis → nothing to re-weight

  await rippleBand(ctx, workspace, saveSnapshot, {
    recalcFrom: null,
    rewrite: ({ frozenHoldings, snapshot }) => {
      const globalValueMinor = globalByDate.get(snapshot.dateKey);
      // Not a date this edit reaches — leave the frozen row exactly as it is.
      if (globalValueMinor === undefined) return undefined;
      return recalculateSnapshotForOwnership({
        frozenHoldings,
        frozenIdentity,
        globalValueMinor,
        holding: asset
          ? { asset, kind: "asset" }
          : { housingAssetIds, kind: "liability", liability: liability! },
        snapshot,
        workspace,
      });
    },
  });
}

/**
 * Re-derive the housing snapshots after a non-dated-fact edit to a real_estate
 * asset (the `firstHousingEventDate` rule, ADR 0020): from-date = first
 * anchor/snapshot date ≤ today. Skips when nothing exists to ripple. Used by
 * both `rippleHousingAfterAssetEdit` (the editAsset ripple-only seam) and the
 * real_estate branch of `updateAssetAndRippleOwnership` (a home ownership edit
 * re-weights through the curve ripple, which honors the asset's new split). The
 * caller wraps it in the enclosing transaction.
 */
export async function rippleHousingAfterEdit(
  ctx: StoreContext,
  stores: { assets: AssetStore; snapshots: SnapshotStore },
  assetId: string,
  today: string,
): Promise<void> {
  const anchors = await stores.assets.readValuationAnchors(assetId);
  const firstAnchorDate = anchors
    .map((a) => a.valuationDate)
    .filter((d) => d <= today)
    .sort()[0];
  const snapshotHoldings = await stores.snapshots.readSnapshotHoldings({
    holdingId: assetId,
    kind: "asset",
  });
  const fromDateKey =
    firstAnchorDate ??
    snapshotHoldings
      .map((r) => r.dateKey)
      .filter((d) => d <= today)
      .sort()[0] ??
    null;
  if (fromDateKey === null || fromDateKey > today) return;
  const workspace = await ctx.getWorkspace();
  if (!workspace) return;
  await rippleHistoricalSnapshotsForValuation(
    ctx,
    workspace,
    stores.snapshots.saveSnapshot,
    {
      assetId,
      fromDateKey,
      today,
    },
  );
}

/** Raise a command executor's typed failure as a thrown error, preserving its
 *  optional `code`. Shared by the dated-fact command families that run their
 *  persist+ripple through `applyDatedFactsBatch`. */
export function throwCommandResultError(result: { error: string; code?: string }): never {
  const error = new Error(result.error);
  if (result.code !== undefined) Object.assign(error, { code: result.code });
  throw error;
}
