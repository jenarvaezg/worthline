import type {
  DomainWarning,
  LiquidityTier,
  NetWorthSnapshot,
  PositionSummary,
  SnapshotHoldingKind,
  SnapshotHoldingRow,
  Workspace,
} from "@worthline/domain";
import {
  assertSnapshotHoldingsReconcile,
  derivePosition,
  resolveScopeMemberIds,
  selectInvestmentPrice,
} from "@worthline/domain";
import type { Database as DatabaseConnection } from "better-sqlite3";
import { and, asc, eq, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";

import { assets, snapshots } from "./schema";
import {
  readAllOperations,
  readAllPriceCache,
  readAssetOwnerships,
  readInvestmentMeta,
  type StoreContext,
} from "./store-context";

export interface SaveSnapshotInput {
  snapshot: NetWorthSnapshot;
  replace?: boolean;
  /**
   * The valued portfolio behind the snapshot's figures (ADR 0008) — saved
   * atomically with the snapshot row. Must reconcile exactly with the
   * snapshot's headline gross assets and debts or the save throws and
   * persists nothing.
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
    readSnapshots: (scopeId) => readSnapshots(ctx.sqlite, scopeId),
    readSnapshotHoldings: (query) => readSnapshotHoldings(ctx.sqlite, query),
    readPositions: (scopeId) =>
      readPositions(ctx.sqlite, ctx.getWorkspace(), scopeId),
  };
}

function saveSnapshot(ctx: StoreContext, input: SaveSnapshotInput): void {
  const { sqlite } = ctx;
  const snapshot = input.snapshot;

  // Reconciliation invariant (ADR 0008): verify before ANY write so a
  // capture whose rows contradict its own figures persists nothing.
  if (input.holdings) {
    assertSnapshotHoldingsReconcile(input.holdings, {
      debtsMinor: snapshot.debts.amountMinor,
      grossAssetsMinor: snapshot.grossAssets.amountMinor,
    });
  }

  ctx.transaction(() => {
    if (snapshot.isMonthlyClose) {
      sqlite
        .prepare(
          `
          UPDATE snapshots
          SET is_monthly_close = 0
          WHERE scope_id = ? AND month_key = ?
        `,
        )
        .run(snapshot.scopeId, snapshot.monthKey);
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
    const existing = sqlite
      .prepare(`SELECT id FROM snapshots WHERE scope_id = ? AND date_key = ?`)
      .get(snapshot.scopeId, snapshot.dateKey) as { id: string } | undefined;

    if (existing) {
      sqlite
        .prepare(`DELETE FROM snapshot_holdings WHERE snapshot_id = ?`)
        .run(existing.id);

      if (input.replace) {
        sqlite.prepare("DELETE FROM snapshots WHERE id = ?").run(existing.id);
      }
    }

    sqlite
      .prepare(
        `
        INSERT INTO snapshots (
          id,
          scope_id,
          scope_label,
          captured_at,
          date_key,
          month_key,
          is_monthly_close,
          currency,
          total_net_worth_minor,
          liquid_net_worth_minor,
          housing_equity_minor,
          gross_assets_minor,
          debts_minor,
          warnings_json
        )
        VALUES (
          @id,
          @scopeId,
          @scopeLabel,
          @capturedAt,
          @dateKey,
          @monthKey,
          @isMonthlyClose,
          @currency,
          @totalNetWorthMinor,
          @liquidNetWorthMinor,
          @housingEquityMinor,
          @grossAssetsMinor,
          @debtsMinor,
          @warningsJson
        )
        ON CONFLICT(scope_id, date_key) DO UPDATE SET
          id = excluded.id,
          scope_label = excluded.scope_label,
          captured_at = excluded.captured_at,
          month_key = excluded.month_key,
          is_monthly_close = excluded.is_monthly_close,
          currency = excluded.currency,
          total_net_worth_minor = excluded.total_net_worth_minor,
          liquid_net_worth_minor = excluded.liquid_net_worth_minor,
          housing_equity_minor = excluded.housing_equity_minor,
          gross_assets_minor = excluded.gross_assets_minor,
          debts_minor = excluded.debts_minor,
          warnings_json = excluded.warnings_json
      `,
      )
      .run({
        capturedAt: snapshot.capturedAt,
        currency: snapshot.totalNetWorth.currency,
        dateKey: snapshot.dateKey,
        debtsMinor: snapshot.debts.amountMinor,
        grossAssetsMinor: snapshot.grossAssets.amountMinor,
        housingEquityMinor: snapshot.housingEquity.amountMinor,
        id: snapshot.id,
        isMonthlyClose: snapshot.isMonthlyClose ? 1 : 0,
        liquidNetWorthMinor: snapshot.liquidNetWorth.amountMinor,
        monthKey: snapshot.monthKey,
        scopeId: snapshot.scopeId,
        scopeLabel: snapshot.scopeLabel,
        totalNetWorthMinor: snapshot.totalNetWorth.amountMinor,
        warningsJson: JSON.stringify(snapshot.warnings),
      });

    if (input.holdings && input.holdings.length > 0) {
      const insertHolding = sqlite.prepare(`
        INSERT INTO snapshot_holdings (
          id,
          snapshot_id,
          holding_id,
          kind,
          label,
          liquidity_tier,
          value_minor,
          units,
          unit_price
        )
        VALUES (
          @id,
          @snapshotId,
          @holdingId,
          @kind,
          @label,
          @liquidityTier,
          @valueMinor,
          @units,
          @unitPrice
        )
      `);

      for (const row of input.holdings) {
        insertHolding.run({
          holdingId: row.holdingId,
          id: ctx.newId(),
          kind: row.kind,
          label: row.label,
          liquidityTier: row.liquidityTier,
          snapshotId: snapshot.id,
          unitPrice: row.unitPrice ?? null,
          units: row.units ?? null,
          valueMinor: row.valueMinor,
        });
      }
    }
  });
}

export function readSnapshots(
  sqlite: DatabaseConnection,
  scopeId?: string,
): NetWorthSnapshot[] {
  const db = drizzle(sqlite);
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

interface SnapshotHoldingDbRow {
  capturedAt: string;
  dateKey: string;
  holdingId: string;
  kind: SnapshotHoldingKind;
  label: string;
  liquidityTier: LiquidityTier | null;
  scopeId: string;
  snapshotId: string;
  unitPrice: string | null;
  units: string | null;
  valueMinor: number;
}

/**
 * Read frozen holding rows (ADR 0008), optionally filtered by scope and by an
 * inclusive date-key window. Rows are joined with their snapshot for identity
 * and ordering — chronological, then assets before liabilities, then by the
 * frozen label for a stable presentation order.
 */
export function readSnapshotHoldings(
  sqlite: DatabaseConnection,
  query: SnapshotHoldingQuery = {},
): SnapshotHoldingRecord[] {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (query.scopeId !== undefined) {
    conditions.push("s.scope_id = ?");
    params.push(query.scopeId);
  }

  if (query.from !== undefined) {
    conditions.push("s.date_key >= ?");
    params.push(query.from);
  }

  if (query.to !== undefined) {
    conditions.push("s.date_key <= ?");
    params.push(query.to);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const rows = sqlite
    .prepare(
      `
      SELECT
        h.snapshot_id AS snapshotId,
        s.scope_id AS scopeId,
        s.date_key AS dateKey,
        s.captured_at AS capturedAt,
        h.holding_id AS holdingId,
        h.kind AS kind,
        h.label AS label,
        h.liquidity_tier AS liquidityTier,
        h.value_minor AS valueMinor,
        h.units AS units,
        h.unit_price AS unitPrice
      FROM snapshot_holdings h
      JOIN snapshots s ON s.id = h.snapshot_id
      ${where}
      ORDER BY s.date_key ASC, s.scope_id ASC, h.kind ASC, h.label ASC, h.holding_id ASC
    `,
    )
    .all(...params) as SnapshotHoldingDbRow[];

  return rows.map((row) => ({
    capturedAt: row.capturedAt,
    dateKey: row.dateKey,
    holdingId: row.holdingId,
    kind: row.kind,
    label: row.label,
    liquidityTier: row.liquidityTier,
    scopeId: row.scopeId,
    snapshotId: row.snapshotId,
    valueMinor: row.valueMinor,
    ...(row.units !== null ? { units: row.units } : {}),
    ...(row.unitPrice !== null ? { unitPrice: row.unitPrice } : {}),
  }));
}

export function readPositions(
  sqlite: DatabaseConnection,
  workspace: Workspace | null,
  scopeId?: string,
): PositionView[] {
  if (!workspace) {
    return [];
  }

  const rows = drizzle(sqlite)
    .select({ currency: assets.currency, id: assets.id, name: assets.name })
    .from(assets)
    .where(and(eq(assets.type, "investment"), isNull(assets.deletedAt)))
    .orderBy(asc(assets.createdAt), asc(assets.id))
    .all();

  if (rows.length === 0) {
    return [];
  }

  const ownershipByAsset = readAssetOwnerships(sqlite);
  const operationsByAsset = readAllOperations(sqlite);
  const metaByAsset = readInvestmentMeta(sqlite);
  const priceCacheByAsset = readAllPriceCache(sqlite);
  const scopeMemberIds = scopeId
    ? new Set(resolveScopeMemberIds(workspace, scopeId))
    : null;

  const views: PositionView[] = [];

  for (const row of rows) {
    const ownership = ownershipByAsset.get(row.id) ?? [];

    if (
      scopeMemberIds &&
      !ownership.some((share) => scopeMemberIds.has(share.memberId))
    ) {
      continue;
    }

    // Price-selection rule is owned by selectInvestmentPrice (ADR 0006).
    // We need the full PositionSummary for the positions table view, so we call
    // derivePosition with the price that selectInvestmentPrice picks.
    const selected = selectInvestmentPrice({
      cachedPrice: priceCacheByAsset.get(row.id)?.price,
      manualPrice: metaByAsset.get(row.id)?.manualPricePerUnit,
    });
    const position = derivePosition(operationsByAsset.get(row.id) ?? [], {
      assetId: row.id,
      currency: row.currency,
      ...(selected ? { currentPricePerUnit: selected.pricePerUnit } : {}),
    });

    views.push({ ...position, name: row.name });
  }

  return views;
}
