import type { AgentViewReadStore, SnapshotHoldingRecord } from "@worthline/db";
import type { MoneyMinor, NetWorthSnapshot } from "@worthline/domain";
import { deriveMonthlyCloses } from "@worthline/domain";

import {
  type AgentViewFinancialSummary,
  AgentViewHttpError,
  type AgentViewIncludeHoldingRows,
  type AgentViewLiquidityTier,
  type AgentViewMoney,
  type AgentViewSnapshotEntry,
  type AgentViewSnapshotGranularity,
  type AgentViewSnapshotHistory,
  type AgentViewSnapshotHoldingRow,
  type AgentViewSnapshotHoldingsSummary,
  type AgentViewSnapshotSort,
  type AgentViewSnapshotTierSummary,
} from "./contract";
import {
  compareDateId,
  type DateIdKey,
  decodeCursor,
  dropAfterCursor,
  encodeCursor,
} from "./cursor";
import { derivePublicId } from "./derived-id";
import { publicIdMap } from "./scope-resolution";
import type { ScopedAgentView } from "./scoped-read";
import { listAgentViewScopes } from "./scopes";

export const DEFAULT_SNAPSHOT_LIMIT = 100;
export const MAX_SNAPSHOT_LIMIT = 500;

/** Cash-first liquidity ladder, matching the live `liquidityBreakdown` order. */
const LIQUIDITY_LADDER: readonly AgentViewLiquidityTier[] = [
  "cash",
  "market",
  "term-locked",
  "illiquid",
  "housing",
];

export interface BuildSnapshotHistoryOptions {
  granularity: AgentViewSnapshotGranularity;
  sort: AgentViewSnapshotSort;
  /** Page size, already clamped to `[1, MAX_SNAPSHOT_LIMIT]` by the caller. */
  limit: number;
  includeHoldingRows: AgentViewIncludeHoldingRows;
  /** Inclusive `YYYY-MM-DD` lower bound on snapshot date. */
  from?: string | undefined;
  /** Inclusive `YYYY-MM-DD` upper bound on snapshot date. */
  to?: string | undefined;
  /** Opaque cursor from a previous page's `meta.nextCursor`. */
  cursor?: string | undefined;
}

/** A snapshot paired with its derived public ID and monthly-close flag. */
interface SortedSnapshot {
  snapshot: NetWorthSnapshot;
  publicId: string;
  isMonthlyClose: boolean;
}

/**
 * Assemble a scope's snapshot history with no side effects (PRD #328, #336):
 * monthly closes by default, raw snapshots on request, with date filters,
 * stable cursor pagination, and optional frozen-holding-row decomposition. Reads
 * persisted snapshots and frozen rows only — never captures, replaces, or
 * ripples (ADR 0023).
 */
export async function buildSnapshotHistory(
  scoped: ScopedAgentView,
  options: BuildSnapshotHistoryOptions,
): Promise<AgentViewSnapshotHistory> {
  const { store } = scoped;
  const workspace = await store.readWorkspace();

  if (!workspace) {
    throw unknownScope();
  }

  const scope = (await listAgentViewScopes(store)).find(
    (candidate) => candidate.id === scoped.scopeId,
  );

  if (!scope) {
    throw unknownScope();
  }

  const internalScopeId = await scoped.internalScopeId();
  const allSnapshots = await store.readSnapshots(internalScopeId);
  const closeIds = new Set(deriveMonthlyCloses(allSnapshots).values());

  const selected =
    options.granularity === "monthly-close"
      ? allSnapshots.filter((snapshot) => closeIds.has(snapshot.id))
      : allSnapshots;

  const filtered = selected.filter(
    (snapshot) =>
      (options.from === undefined || snapshot.dateKey >= options.from) &&
      (options.to === undefined || snapshot.dateKey <= options.to),
  );

  const sorted: SortedSnapshot[] = filtered
    .map((snapshot) => ({
      isMonthlyClose: closeIds.has(snapshot.id),
      publicId: deriveSnapshotPublicId(internalScopeId, snapshot.dateKey),
      snapshot,
    }))
    .sort((a, b) => compareDateId(snapshotKey(a), snapshotKey(b), options.sort));

  const afterCursor = options.cursor
    ? dropAfterCursor(sorted, decodeCursor(options.cursor), options.sort, snapshotKey)
    : sorted;

  const page = afterCursor.slice(0, options.limit);
  const hasNext = afterCursor.length > options.limit;
  const last = page[page.length - 1];
  const nextCursor =
    hasNext && last ? encodeCursor(last.snapshot.dateKey, last.publicId) : undefined;

  const rowsBySnapshotId = await readHoldingRows(store, internalScopeId, page, options);

  return {
    entries: await Promise.all(
      page.map((entry) =>
        toEntry(
          entry,
          workspace.baseCurrency,
          options.includeHoldingRows,
          rowsBySnapshotId,
          store,
        ),
      ),
    ),
    meta: {
      hasNext,
      limit: options.limit,
      ...(nextCursor === undefined ? {} : { nextCursor }),
    },
  };
}

async function toEntry(
  entry: SortedSnapshot,
  currency: string,
  includeHoldingRows: AgentViewIncludeHoldingRows,
  rowsBySnapshotId: Map<string, SnapshotHoldingRecord[]>,
  store: AgentViewReadStore,
): Promise<AgentViewSnapshotEntry> {
  const records = rowsBySnapshotId.get(entry.snapshot.id) ?? [];

  return {
    date: entry.snapshot.dateKey,
    id: entry.publicId,
    isMonthlyClose: entry.isMonthlyClose,
    object: "snapshot",
    summary: toSummary(entry.snapshot, currency),
    ...(includeHoldingRows === "summary"
      ? { holdingRowsSummary: toHoldingsSummary(records, currency) }
      : {}),
    ...(includeHoldingRows === "full"
      ? {
          holdingRows: await Promise.all(
            records.map((record) => toHoldingRow(record, currency, store)),
          ),
        }
      : {}),
  };
}

function toSummary(
  snapshot: NetWorthSnapshot,
  currency: string,
): AgentViewFinancialSummary {
  return {
    debts: money(snapshot.debts, currency),
    grossAssets: money(snapshot.grossAssets, currency),
    housingEquity: money(snapshot.housingEquity, currency),
    liquidNetWorth: money(snapshot.liquidNetWorth, currency),
    netWorth: money(snapshot.totalNetWorth, currency),
  };
}

/**
 * Read the frozen holding rows for the page's snapshots, grouped by snapshot id.
 * Narrowed to the page's date window so a large history reads only the rows it
 * serves. Skipped entirely when holding rows are not requested.
 */
async function readHoldingRows(
  store: AgentViewReadStore,
  internalScopeId: string,
  page: SortedSnapshot[],
  options: BuildSnapshotHistoryOptions,
): Promise<Map<string, SnapshotHoldingRecord[]>> {
  if (options.includeHoldingRows === "none" || page.length === 0) {
    return new Map();
  }

  const dateKeys = page.map((entry) => entry.snapshot.dateKey).sort();
  const from = dateKeys[0];
  const to = dateKeys[dateKeys.length - 1];
  const records = await store.readSnapshotHoldings({
    scopeId: internalScopeId,
    ...(from === undefined ? {} : { from }),
    ...(to === undefined ? {} : { to }),
  });

  const grouped = new Map<string, SnapshotHoldingRecord[]>();
  for (const record of records) {
    const existing = grouped.get(record.snapshotId);
    if (existing) {
      existing.push(record);
    } else {
      grouped.set(record.snapshotId, [record]);
    }
  }
  return grouped;
}

async function toHoldingRow(
  record: SnapshotHoldingRecord,
  currency: string,
  store: AgentViewReadStore,
): Promise<AgentViewSnapshotHoldingRow> {
  const publicId = await holdingPublicId(store, record.holdingId);

  return {
    kind: record.kind,
    label: record.label,
    liquidityTier: record.liquidityTier,
    value: moneyOf(record.valueMinor, currency),
    ...(publicId
      ? { holding: { id: publicId, label: record.label, object: "holding" as const } }
      : {}),
    ...(record.units !== undefined ? { units: record.units } : {}),
    ...(record.unitPrice !== undefined ? { unitPrice: record.unitPrice } : {}),
  };
}

/**
 * Fold the frozen rows into a per-rung decomposition mirroring the live
 * `buildLiquidityBreakdown`: asset rows bucket by their frozen rung (housing
 * assets already carry the `housing` rung), liability rows by their frozen rung
 * (an unsecured liability — null rung — lands on `cash`, the same fallback the
 * live net-worth path applies). Always reports all five rungs in cash-first
 * order for a stable shape, even when a rung is empty.
 */
function toHoldingsSummary(
  records: SnapshotHoldingRecord[],
  currency: string,
): AgentViewSnapshotHoldingsSummary {
  const grossByTier = new Map<AgentViewLiquidityTier, number>();
  const debtByTier = new Map<AgentViewLiquidityTier, number>();

  for (const record of records) {
    const tier = (record.liquidityTier ?? "cash") as AgentViewLiquidityTier;
    if (record.kind === "asset") {
      grossByTier.set(tier, (grossByTier.get(tier) ?? 0) + record.valueMinor);
    } else {
      debtByTier.set(tier, (debtByTier.get(tier) ?? 0) + record.valueMinor);
    }
  }

  const byLiquidityTier: AgentViewSnapshotTierSummary[] = LIQUIDITY_LADDER.map((tier) => {
    const grossMinor = grossByTier.get(tier) ?? 0;
    const debtMinor = debtByTier.get(tier) ?? 0;
    return {
      debts: moneyOf(debtMinor, currency),
      grossAssets: moneyOf(grossMinor, currency),
      netValue: moneyOf(grossMinor - debtMinor, currency),
      tier,
    };
  });

  return { byLiquidityTier, rowCount: records.length };
}

/** This snapshot's stable sort key: its date then its derived public ID. */
function snapshotKey(entry: SortedSnapshot): DateIdKey {
  return { dateKey: entry.snapshot.dateKey, publicId: entry.publicId };
}

/**
 * Derive a snapshot's opaque public ID from its stable natural key
 * (internal scope + date). Deterministic, so it survives export/import (both
 * key parts do) and never churns on the same-day replace that rewrites the
 * internal snapshot id; opaque, so it leaks neither labels nor internal ids
 * (ADR 0023). No registry write — a read derives it without mutating state.
 */
export function deriveSnapshotPublicId(internalScopeId: string, dateKey: string): string {
  return derivePublicId("snp", `${internalScopeId} ${dateKey}`);
}

async function holdingPublicId(
  store: AgentViewReadStore,
  holdingId: string,
): Promise<string | undefined> {
  return publicIdMap(await store.readPublicIds(), "holding").get(holdingId);
}

function money(value: MoneyMinor, currency: string): AgentViewMoney {
  return { amountMinor: value.amountMinor, currency: value.currency || currency };
}

function moneyOf(amountMinor: number, currency: string): AgentViewMoney {
  return { amountMinor, currency };
}

function unknownScope(): AgentViewHttpError {
  return new AgentViewHttpError({
    code: "not_found",
    message: "Unknown scope.",
    status: 404,
  });
}
