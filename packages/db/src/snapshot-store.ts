import type {
  DomainWarning,
  NetWorthSnapshot,
  PositionSummary,
  RawInvestmentRow,
  SnapshotHoldingRow,
  Workspace,
} from "@worthline/domain";
import { assertSnapshotHoldingsReconcile, projectPositions } from "@worthline/domain";
import { and, asc, eq, gte, isNull, lte, sql, type SQL } from "drizzle-orm";

import { assets, snapshotHoldings, snapshots } from "./schema";
import {
  buildAssetProjectionContext,
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

/** Filter for reading frozen holding rows: by scope and optional date-key window (inclusive). */
export interface SnapshotHoldingQuery {
  scopeId?: string;
  from?: string;
  to?: string;
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
 * Snapshot and position persistence (Slice R1 of the architectural refactor,
 * PRD #120 / #121). Owns the snapshot rows, their frozen holding rows (ADR
 * 0008), and the derived live positions read off the investment assets.
 */
export interface SnapshotStore {
  saveSnapshot: (input: SaveSnapshotInput) => void;
  readSnapshots: (scopeId?: string) => NetWorthSnapshot[];
  readSnapshotHoldings: (query?: SnapshotHoldingQuery) => SnapshotHoldingRecord[];
  readPositions: (scopeId?: string) => PositionView[];
}

export function createSnapshotStore(ctx: StoreContext): SnapshotStore {
  return {
    saveSnapshot: (input) => saveSnapshot(ctx, input),
    readSnapshots: (scopeId) => readSnapshots(ctx.db, scopeId),
    readSnapshotHoldings: (query) => readSnapshotHoldings(ctx.db, query),
    readPositions: (scopeId) => readPositions(ctx.db, ctx.getWorkspace(), scopeId),
  };
}

function saveSnapshot(ctx: StoreContext, input: SaveSnapshotInput): void {
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
  ctx.transaction(() => {
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
    const existing = db
      .select({ id: snapshots.id })
      .from(snapshots)
      .where(
        and(
          eq(snapshots.scopeId, snapshot.scopeId),
          eq(snapshots.dateKey, snapshot.dateKey),
        ),
      )
      .get();

    if (existing) {
      db.delete(snapshotHoldings)
        .where(eq(snapshotHoldings.snapshotId, existing.id))
        .run();

      if (input.replace) {
        db.delete(snapshots).where(eq(snapshots.id, existing.id)).run();
      }
    }

    db.insert(snapshots)
      .values({
        capturedAt: snapshot.capturedAt,
        currency: snapshot.totalNetWorth.currency,
        dateKey: snapshot.dateKey,
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
      db.insert(snapshotHoldings)
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
    }
  });
}

export function readSnapshots(db: StoreDb, scopeId?: string): NetWorthSnapshot[] {
  const rows = scopeId
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
        .all();

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
 * Read frozen holding rows (ADR 0008), optionally filtered by scope and by an
 * inclusive date-key window. Rows are joined with their snapshot for identity
 * and ordering — chronological, then assets before liabilities, then by the
 * frozen label for a stable presentation order. Dynamic WHERE is built as a
 * Drizzle condition list (mirroring readSnapshots), so the filter never drops
 * to raw SQL.
 */
export function readSnapshotHoldings(
  db: StoreDb,
  query: SnapshotHoldingQuery = {},
): SnapshotHoldingRecord[] {
  const conditions: SQL[] = [];

  if (query.scopeId !== undefined) {
    conditions.push(eq(snapshots.scopeId, query.scopeId));
  }

  if (query.from !== undefined) {
    conditions.push(gte(snapshots.dateKey, query.from));
  }

  if (query.to !== undefined) {
    conditions.push(lte(snapshots.dateKey, query.to));
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

  const rows = filtered
    .orderBy(
      asc(snapshots.dateKey),
      asc(snapshots.scopeId),
      asc(snapshotHoldings.kind),
      asc(snapshotHoldings.label),
      asc(snapshotHoldings.holdingId),
    )
    .all();

  return rows.map((row) => ({
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
  }));
}

/**
 * Read the live investment positions for the dashboard. The store reads the raw
 * investment rows and the raw supporting maps, then hands them to the domain
 * projection (projectPositions), which owns the price-selection rule (ADR 0006)
 * and the position math (derivePosition). The store no longer computes positions
 * itself (PRD #120 candidate 3, R10).
 */
export function readPositions(
  db: StoreDb,
  workspace: Workspace | null,
  scopeId?: string,
): PositionView[] {
  if (!workspace) {
    return [];
  }

  const rows: RawInvestmentRow[] = db
    .select({ currency: assets.currency, id: assets.id, name: assets.name })
    .from(assets)
    .where(and(eq(assets.type, "investment"), isNull(assets.deletedAt)))
    .orderBy(asc(assets.createdAt), asc(assets.id))
    .all();

  if (rows.length === 0) {
    return [];
  }

  const projectionContext = buildAssetProjectionContext(db, true);

  return projectPositions(workspace, rows, projectionContext, scopeId);
}
