import type {
  AssetProjectionContext,
  DomainWarning,
  InvestmentCaptureDetail,
  Liability,
  ManualAsset,
  NetWorthSnapshot,
  PositionSummary,
  RawInvestmentRow,
  SnapshotHoldingKind,
  SnapshotHoldingRow,
  SnapshotPositionRow,
  Workspace,
} from "@worthline/domain";
import {
  asDateKey,
  asInstant,
  assertSnapshotHoldingsReconcile,
  projectPositions,
  projectScopedPositionsWithDetails,
} from "@worthline/domain";
import {
  and,
  asc,
  desc,
  eq,
  gte,
  inArray,
  isNull,
  lte,
  sql,
  type SQL,
} from "drizzle-orm";

import { assets, snapshotHoldings, snapshotPositionHoldings, snapshots } from "./schema";
import { valueLiveHoldingsAtDate } from "./curve-valued-holdings";
import {
  buildAssetProjectionContext,
  readAssets as readLiveAssets,
  readLiabilities as readLiveLiabilities,
  type StoreContext,
  type StoreDb,
} from "./store-context";

export interface SaveSnapshotInput {
  snapshot: NetWorthSnapshot;
  replace?: boolean;
  /**
   * The valued portfolio behind the snapshot's figures (ADR 0008) — saved
   * atomically with the snapshot row. Must reconcile exactly with all five
   * headline figures (gross assets, debts, total / liquid net worth, housing
   * equity); callers build holdings through the reconciling capture functions
   * (ADR 0008), and `saveSnapshot` re-asserts the invariant inside its
   * transaction as a backstop (#185) so a non-reconciling set persists nothing.
   */
  holdings?: SnapshotHoldingRow[];
}

/**
 * Filter for reading frozen holding rows: by scope and optional date-key window
 * (inclusive), and/or targeted to a single holding by its id + kind. The
 * holding-id / kind pair lets a caller (e.g. the housing valuation ripples,
 * #207) read just the frozen rows of one asset/liability through the
 * `snapshot_holdings (holding_id, kind)` index, instead of pulling every frozen
 * row into memory and filtering there.
 */
export interface SnapshotHoldingQuery {
  scopeId?: string;
  from?: string;
  to?: string;
  holdingId?: string;
  kind?: SnapshotHoldingKind;
}

/** A frozen holding row joined with its snapshot's identity and date. */
export interface SnapshotHoldingRecord extends SnapshotHoldingRow {
  snapshotId: string;
  scopeId: string;
  dateKey: string;
  capturedAt: string;
}

/** A derived position plus the asset name, for the dashboard positions table. */
export interface PositionView extends PositionSummary {
  name: string;
}

/**
 * The selected scope's positions plus the UNSCOPED per-investment capture details
 * (units + unit price, ADR 0008), built from ONE shared projection context (#208).
 * A dashboard load needs both off the same raw operation read — the capture
 * details freeze every scope's snapshot rows, the positions drive the selected
 * scope's table — so serving them together avoids reading every operation twice.
 */
export interface ScopedPositionsWithDetails {
  positions: PositionView[];
  details: Map<string, InvestmentCaptureDetail>;
}

/**
 * Snapshot and position persistence (Slice R1 of the architectural refactor,
 * PRD #120 / #121). Owns the snapshot rows, their frozen holding rows (ADR
 * 0008), and the derived live positions read off the investment assets.
 */
export interface SnapshotStore {
  saveSnapshot: (input: SaveSnapshotInput) => Promise<void>;
  readSnapshots: (scopeId?: string) => Promise<NetWorthSnapshot[]>;
  readSnapshotHoldings: (
    query?: SnapshotHoldingQuery,
  ) => Promise<SnapshotHoldingRecord[]>;
  readPositions: (scopeId?: string) => Promise<PositionView[]>;
  /**
   * Read the selected scope's positions AND the unscoped capture details in one
   * pass over the raw operations (#208): the dashboard load needs both per
   * request, and building them from a single projection context reads every
   * operation once instead of twice. Byte-identical to deriving the details from
   * `readPositions()` and reading `readPositions(scopeId)` separately.
   *
   * @param projectionContext - Optional pre-built context (dedup #566). When
   *   provided, the internal build is skipped and the supplied context is used
   *   directly. See `buildProjectionContext` to build the shared context once.
   */
  readScopedPositionsWithDetails: (
    scopeId?: string,
    projectionContext?: AssetProjectionContext,
  ) => Promise<ScopedPositionsWithDetails>;
  /**
   * Read the current live ledger valued on the supplied date. Housing and
   * modelled debts are sampled through their curves with batched reads; holdings
   * without a curve keep their stored current value/balance. Callers use this
   * before computing live figures or freezing a snapshot so both paths agree.
   */
  readCurveValuedHoldingsAtDate: (
    dateKey: string,
    projectionContext?: AssetProjectionContext,
  ) => Promise<{ assets: ManualAsset[]; liabilities: Liability[] }>;
  /**
   * Build the raw projection context (operations, investment meta, price cache,
   * ownerships) with `hasInvestments = true` — the union that covers all asset
   * types. Use this once per cold dashboard load and pass the result to both
   * `readAssets` and `readScopedPositionsWithDetails` to avoid the second
   * identical build (dedup #566).
   *
   * Safety invariant: call this AFTER all writes to the four underlying tables
   * complete (i.e. after §1 price refresh + upsertPrice in load-dashboard.ts).
   */
  buildProjectionContext: () => Promise<AssetProjectionContext>;
}

export function createSnapshotStore(ctx: StoreContext): SnapshotStore {
  return {
    saveSnapshot: (input) => saveSnapshot(ctx, input),
    readSnapshots: (scopeId) => readSnapshots(ctx.db, scopeId),
    readSnapshotHoldings: (query) => readSnapshotHoldings(ctx.db, query),
    readPositions: async (scopeId) =>
      readPositions(ctx.db, await ctx.getWorkspace(), scopeId),
    readScopedPositionsWithDetails: async (scopeId, projectionContext) =>
      readScopedPositionsWithDetails(
        ctx.db,
        await ctx.getWorkspace(),
        scopeId,
        projectionContext,
      ),
    readCurveValuedHoldingsAtDate: async (dateKey, projectionContext) => {
      const workspace = await ctx.getWorkspace();
      if (!workspace) return { assets: [], liabilities: [] };
      const [liveAssets, liveLiabilities] = await Promise.all([
        readLiveAssets(ctx.db, workspace, projectionContext),
        readLiveLiabilities(ctx.db, workspace),
      ]);
      return valueLiveHoldingsAtDate(ctx.db, liveAssets, liveLiabilities, dateKey);
    },
    buildProjectionContext: () => buildAssetProjectionContext(ctx.db, true),
  };
}

async function saveSnapshot(ctx: StoreContext, input: SaveSnapshotInput): Promise<void> {
  const { db } = ctx;
  const snapshot = input.snapshot;

  // Backstop the reconciliation invariant (ADR 0008, extended to all five
  // figures in #181) at the store's single most-used write seam (#185). Every
  // ripple and the daily capture funnel through here; callers build holdings
  // through the reconciling capture functions, but re-checking inside the
  // transaction means the invariant no longer depends on every one of ~9 call
  // sites getting it right — and because the assert runs BEFORE any insert, a
  // mismatch throws and rolls back, persisting nothing. The assert sees the
  // same rows and figures being persisted. Empty holdings (legacy / no-portfolio
  // captures) carry no rows to reconcile, so the check is skipped.
  await ctx.transaction(async () => {
    if (input.holdings && input.holdings.length > 0) {
      assertSnapshotHoldingsReconcile(input.holdings, {
        debtsMinor: snapshot.debts.amountMinor,
        grossAssetsMinor: snapshot.grossAssets.amountMinor,
        housingEquityMinor: snapshot.housingEquity.amountMinor,
        liquidNetWorthMinor: snapshot.liquidNetWorth.amountMinor,
        totalNetWorthMinor: snapshot.totalNetWorth.amountMinor,
      });
    }

    // Upsert on (scope_id, date_key): concurrent first-loads degrade
    // gracefully — the second write updates rather than throwing.
    // explicit replace flag keeps the old id-based delete path for callers
    // that need to force a specific snapshot id.
    //
    // Either way the same-day snapshot is superseded, so its holding rows
    // go with it — at most one set of rows per scope per day. The delete
    // must run before the upsert because the upsert rewrites the parent
    // snapshot id that the rows' foreign key points at.
    const existing = await db
      .select({ id: snapshots.id })
      .from(snapshots)
      .where(
        and(
          eq(snapshots.scopeId, snapshot.scopeId),
          eq(snapshots.dateKey, asDateKey(snapshot.dateKey)),
        ),
      )
      .get();

    if (existing) {
      // Drop the prior frozen rows AND their per-position children (ADR 0035)
      // before the re-insert; the unique (snapshot, holding, position_key) index
      // would otherwise reject a same-day recapture. On the replace path the FK
      // cascade would also clear the children, but the no-replace upsert keeps the
      // snapshot row, so the explicit delete is what frees the children there.
      await db
        .delete(snapshotPositionHoldings)
        .where(eq(snapshotPositionHoldings.snapshotId, existing.id))
        .run();
      await db
        .delete(snapshotHoldings)
        .where(eq(snapshotHoldings.snapshotId, existing.id))
        .run();

      if (input.replace) {
        await db.delete(snapshots).where(eq(snapshots.id, existing.id)).run();
      }
    }

    await db
      .insert(snapshots)
      .values({
        capturedAt: asInstant(snapshot.capturedAt),
        currency: snapshot.totalNetWorth.currency,
        dateKey: asDateKey(snapshot.dateKey),
        debtsMinor: snapshot.debts.amountMinor,
        grossAssetsMinor: snapshot.grossAssets.amountMinor,
        housingEquityMinor: snapshot.housingEquity.amountMinor,
        id: snapshot.id,
        // The monthly close is DERIVED — the last snapshot of each month wins
        // (ADR 0005); the declared flag is retired and the read side ignores
        // this column. Write a constant 0 rather than carrying the dead flag,
        // and never clear other rows' closes (that branch was unreachable
        // write-only code that would have mutated frozen history if revived) (#185).
        isMonthlyClose: 0,
        liquidNetWorthMinor: snapshot.liquidNetWorth.amountMinor,
        monthKey: snapshot.monthKey,
        scopeId: snapshot.scopeId,
        scopeLabel: snapshot.scopeLabel,
        totalNetWorthMinor: snapshot.totalNetWorth.amountMinor,
        warningsJson: JSON.stringify(snapshot.warnings),
      })
      .onConflictDoUpdate({
        target: [snapshots.scopeId, snapshots.dateKey],
        set: {
          id: sql`excluded.id`,
          scopeLabel: sql`excluded.scope_label`,
          capturedAt: sql`excluded.captured_at`,
          monthKey: sql`excluded.month_key`,
          // is_monthly_close is derived (ADR 0005) and always written 0; no need
          // to copy it on conflict — the inserted constant already stands (#185).
          currency: sql`excluded.currency`,
          totalNetWorthMinor: sql`excluded.total_net_worth_minor`,
          liquidNetWorthMinor: sql`excluded.liquid_net_worth_minor`,
          housingEquityMinor: sql`excluded.housing_equity_minor`,
          grossAssetsMinor: sql`excluded.gross_assets_minor`,
          debtsMinor: sql`excluded.debts_minor`,
          warningsJson: sql`excluded.warnings_json`,
        },
      })
      .run();

    if (input.holdings && input.holdings.length > 0) {
      await db
        .insert(snapshotHoldings)
        .values(
          input.holdings.map((row) => ({
            countsAsHousing: row.countsAsHousing ? 1 : 0,
            holdingId: row.holdingId,
            id: ctx.newId(),
            kind: row.kind,
            label: row.label,
            liquidityTier: row.liquidityTier,
            securesHousing: row.securesHousing ? 1 : 0,
            snapshotId: snapshot.id,
            unitPrice: row.unitPrice ?? null,
            units: row.units ?? null,
            valueMinor: row.valueMinor,
          })),
        )
        .run();

      // Per-position child rows of any connected-source holding (ADR 0035). They
      // reconcile to their parent holding by construction (the capture builds them
      // that way and assertSnapshotHoldingsReconcile re-checks the sub-sum above).
      const positionRows = input.holdings.flatMap((row) =>
        (row.positions ?? []).map((position) => ({
          id: ctx.newId(),
          imageUrl: position.imageUrl,
          label: position.label,
          metal: position.metal,
          parentHoldingId: row.holdingId,
          positionKey: position.positionKey,
          snapshotId: snapshot.id,
          valueMinor: position.valueMinor,
        })),
      );
      if (positionRows.length > 0) {
        await db.insert(snapshotPositionHoldings).values(positionRows).run();
      }
    }
  });
}

export async function readSnapshots(
  db: StoreDb,
  scopeId?: string,
): Promise<NetWorthSnapshot[]> {
  const rows = await (scopeId
    ? db
        .select()
        .from(snapshots)
        .where(eq(snapshots.scopeId, scopeId))
        .orderBy(asc(snapshots.capturedAt), asc(snapshots.id))
        .all()
    : db
        .select()
        .from(snapshots)
        .orderBy(asc(snapshots.capturedAt), asc(snapshots.id))
        .all());

  return rows.map((row) => ({
    capturedAt: row.capturedAt,
    dateKey: row.dateKey,
    debts: { amountMinor: row.debtsMinor, currency: row.currency },
    grossAssets: { amountMinor: row.grossAssetsMinor, currency: row.currency },
    housingEquity: { amountMinor: row.housingEquityMinor, currency: row.currency },
    id: row.id,
    isMonthlyClose: row.isMonthlyClose === 1,
    liquidNetWorth: { amountMinor: row.liquidNetWorthMinor, currency: row.currency },
    monthKey: row.monthKey,
    scopeId: row.scopeId,
    scopeLabel: row.scopeLabel,
    totalNetWorth: { amountMinor: row.totalNetWorthMinor, currency: row.currency },
    warnings: JSON.parse(row.warningsJson) as DomainWarning[],
  }));
}

/**
 * Read frozen holding rows (ADR 0008), optionally filtered by scope, by an
 * inclusive date-key window, and/or targeted to a single holding by its id +
 * kind (#207). Rows are joined with their snapshot for identity and ordering —
 * chronological, then assets before liabilities, then by the frozen label for a
 * stable presentation order. Dynamic WHERE is built as a Drizzle condition list
 * (mirroring readSnapshots), so the filter never drops to raw SQL. A
 * holding-id / kind filter resolves through the
 * `snapshot_holdings (holding_id, kind)` index, so a caller reads one asset's
 * frozen rows without scanning the whole table.
 */
export async function readSnapshotHoldings(
  db: StoreDb,
  query: SnapshotHoldingQuery = {},
): Promise<SnapshotHoldingRecord[]> {
  const conditions: SQL[] = [];

  if (query.scopeId !== undefined) {
    conditions.push(eq(snapshots.scopeId, query.scopeId));
  }

  if (query.from !== undefined) {
    conditions.push(gte(snapshots.dateKey, asDateKey(query.from)));
  }

  if (query.to !== undefined) {
    conditions.push(lte(snapshots.dateKey, asDateKey(query.to)));
  }

  // Targeted single-holding read (#207): keyed by the frozen row's own id + kind
  // so it resolves through `snapshot_holdings_holding_kind_idx` rather than
  // scanning every frozen row. The housing ripples ask for one asset's dates.
  if (query.holdingId !== undefined) {
    conditions.push(eq(snapshotHoldings.holdingId, query.holdingId));
  }

  if (query.kind !== undefined) {
    conditions.push(eq(snapshotHoldings.kind, query.kind));
  }

  const baseQuery = db
    .select({
      snapshotId: snapshotHoldings.snapshotId,
      scopeId: snapshots.scopeId,
      dateKey: snapshots.dateKey,
      capturedAt: snapshots.capturedAt,
      countsAsHousing: snapshotHoldings.countsAsHousing,
      holdingId: snapshotHoldings.holdingId,
      kind: snapshotHoldings.kind,
      label: snapshotHoldings.label,
      liquidityTier: snapshotHoldings.liquidityTier,
      securesHousing: snapshotHoldings.securesHousing,
      valueMinor: snapshotHoldings.valueMinor,
      units: snapshotHoldings.units,
      unitPrice: snapshotHoldings.unitPrice,
    })
    .from(snapshotHoldings)
    .innerJoin(snapshots, eq(snapshots.id, snapshotHoldings.snapshotId));

  const filtered =
    conditions.length > 0 ? baseQuery.where(and(...conditions)) : baseQuery;

  const rows = await filtered
    .orderBy(
      asc(snapshots.dateKey),
      asc(snapshots.scopeId),
      asc(snapshotHoldings.kind),
      asc(snapshotHoldings.label),
      asc(snapshotHoldings.holdingId),
    )
    .all();

  // Attach each connected holding's frozen per-position child rows (ADR 0035),
  // read in one indexed pass over the snapshots in the result and grouped by their
  // parent (snapshot + holding). Ordered most-valuable first for a stable second
  // drilldown level; holdings with no children stay plain (no `positions` field).
  //
  // Skipped on a targeted single-holding read (`holdingId`): those serve the
  // ripple/recalc hot paths over investments and housing — never connected coin
  // collections — and never render the drilldown, so the extra read (a wide
  // `IN (…snapshotIds)` over one holding's whole history) would be pure overhead.
  const positionsByHolding =
    query.holdingId !== undefined
      ? new Map<string, SnapshotPositionRow[]>()
      : await readPositionsByHolding(db, [...new Set(rows.map((row) => row.snapshotId))]);

  return rows.map((row) => {
    const positions = positionsByHolding.get(`${row.snapshotId}::${row.holdingId}`);
    return {
      capturedAt: row.capturedAt,
      countsAsHousing: row.countsAsHousing === 1,
      dateKey: row.dateKey,
      holdingId: row.holdingId,
      kind: row.kind,
      label: row.label,
      liquidityTier: row.liquidityTier,
      scopeId: row.scopeId,
      securesHousing: row.securesHousing === 1,
      snapshotId: row.snapshotId,
      valueMinor: row.valueMinor,
      ...(row.units !== null ? { units: row.units } : {}),
      ...(row.unitPrice !== null ? { unitPrice: row.unitPrice } : {}),
      ...(positions ? { positions } : {}),
    };
  });
}

/**
 * Read the per-position child rows (ADR 0035) for a set of snapshots, grouped by
 * their parent `${snapshotId}::${parentHoldingId}` so the holding read can attach
 * each holding its own coins/tokens. Ordered by value descending (then key) for a
 * stable, most-valuable-first second drilldown level. Empty input → empty map.
 */
async function readPositionsByHolding(
  db: StoreDb,
  snapshotIds: readonly string[],
): Promise<Map<string, SnapshotPositionRow[]>> {
  const byHolding = new Map<string, SnapshotPositionRow[]>();
  if (snapshotIds.length === 0) return byHolding;

  const rows = await db
    .select({
      snapshotId: snapshotPositionHoldings.snapshotId,
      parentHoldingId: snapshotPositionHoldings.parentHoldingId,
      positionKey: snapshotPositionHoldings.positionKey,
      label: snapshotPositionHoldings.label,
      valueMinor: snapshotPositionHoldings.valueMinor,
      metal: snapshotPositionHoldings.metal,
      imageUrl: snapshotPositionHoldings.imageUrl,
    })
    .from(snapshotPositionHoldings)
    .where(inArray(snapshotPositionHoldings.snapshotId, [...snapshotIds]))
    .orderBy(
      desc(snapshotPositionHoldings.valueMinor),
      asc(snapshotPositionHoldings.positionKey),
    )
    .all();

  for (const row of rows) {
    const key = `${row.snapshotId}::${row.parentHoldingId}`;
    const position: SnapshotPositionRow = {
      positionKey: row.positionKey,
      label: row.label,
      valueMinor: row.valueMinor,
      metal: row.metal,
      imageUrl: row.imageUrl,
    };
    const list = byHolding.get(key);
    if (list) list.push(position);
    else byHolding.set(key, [position]);
  }

  return byHolding;
}

/**
 * Read the raw live investment rows in their stable presentation order. Shared by
 * `readPositions` and `readScopedPositionsWithDetails` so the raw-read shape never
 * drifts between them.
 */
function readInvestmentRows(db: StoreDb): Promise<RawInvestmentRow[]> {
  return db
    .select({ currency: assets.currency, id: assets.id, name: assets.name })
    .from(assets)
    .where(and(eq(assets.type, "investment"), isNull(assets.deletedAt)))
    .orderBy(asc(assets.createdAt), asc(assets.id))
    .all();
}

/**
 * Read the live investment positions for the dashboard. The store reads the raw
 * investment rows and the raw supporting maps, then hands them to the domain
 * projection (projectPositions), which owns the price-selection rule (ADR 0006)
 * and the position math (derivePosition). The store no longer computes positions
 * itself (PRD #120 candidate 3, R10).
 */
export async function readPositions(
  db: StoreDb,
  workspace: Workspace | null,
  scopeId?: string,
): Promise<PositionView[]> {
  if (!workspace) {
    return [];
  }

  const rows = await readInvestmentRows(db);

  if (rows.length === 0) {
    return [];
  }

  const projectionContext = await buildAssetProjectionContext(db, true);

  return projectPositions(workspace, rows, projectionContext, scopeId);
}

/**
 * Read the selected scope's positions and the unscoped capture details in ONE
 * pass over the raw operations (#208). The store gathers the raw rows and the
 * supporting maps exactly once and the domain projection
 * (projectScopedPositionsWithDetails) derives both views from that single context
 * — so a dashboard load reads every operation once, not once per `readPositions`
 * call. The figures are byte-identical to the two separate reads it replaces.
 *
 * @param projectionContext - Optional pre-built context (dedup #566). When
 *   provided, the internal `buildAssetProjectionContext` call is skipped and the
 *   supplied context is used directly, eliminating the second redundant build on
 *   a cold dashboard load.
 */
export async function readScopedPositionsWithDetails(
  db: StoreDb,
  workspace: Workspace | null,
  scopeId?: string,
  projectionContext?: AssetProjectionContext,
): Promise<ScopedPositionsWithDetails> {
  if (!workspace) {
    return { details: new Map(), positions: [] };
  }

  const rows = await readInvestmentRows(db);

  if (rows.length === 0) {
    return { details: new Map(), positions: [] };
  }

  const ctx = projectionContext ?? (await buildAssetProjectionContext(db, true));

  return projectScopedPositionsWithDetails(workspace, rows, ctx, scopeId);
}
