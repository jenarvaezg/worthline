/**
 * Historical-price backfill candidate detection (#380, ADR 0033).
 *
 * The pure decision behind the "Rellenar histórico de precios" action: which
 * `derived` investments have backdated operations whose old snapshots are frozen
 * at COST BASIS (units present, no unit price — the ADR 0006 fallback when no
 * provider/manual price was cached that day), so the chart jumps the day the
 * first real quote arrives. An investment qualifies only when it ALSO carries a
 * provider symbol (the backfill has a source to ask) — without one there is no
 * way to source historical prices, so it is silently skipped.
 *
 * Pure module: every input is passed in (the db layer reads the asset metadata,
 * the operation ledger, and the frozen snapshot rows and hands them over), so
 * detection is testable without the network or a store, and never reads a clock.
 */

import type { InvestmentOperation } from "./investment-types";
import type { InvestmentPriceProvider } from "./prices";

/** The investment-asset metadata detection reads (one row per investment). */
export interface PriceBackfillCandidateAsset {
  assetId: string;
  /** The configured price provider (yahoo | stooq | finect | coingecko). */
  priceProvider: InvestmentPriceProvider;
  /** The provider symbol; undefined when none is configured (→ never a candidate). */
  providerSymbol?: string;
}

/**
 * The slice of a frozen `snapshot_holdings` row detection reads: a row is "at
 * cost basis" when it has `units` but no `unitPrice` (the ADR 0006 fallback).
 */
export interface PriceBackfillSnapshotRow {
  holdingId: string;
  kind: "asset" | "liability";
  dateKey: string;
  units?: string;
  unitPrice?: string;
}

/** One detected backfill candidate, with the audit counts the preview surfaces. */
export interface PriceBackfillCandidate {
  assetId: string;
  priceProvider: InvestmentPriceProvider;
  providerSymbol: string;
  /** The earliest operation date (YYYY-MM-DD) — the backfill's lower bound. */
  firstOperationDate: string;
  /**
   * How many DISTINCT historical dates are frozen at cost for this asset.
   * INFORMATIONAL ONLY: this is a candidacy/audit hint, deliberately NOT the
   * preview's create/update counts — those are the scope-aware figures the apply
   * seam's dry run returns (a date can be a create in one scope and an update in
   * another, which this single number cannot express).
   */
  monthsAtCost: number;
}

export interface DetectPriceBackfillInput {
  /** Every live investment asset's detection metadata. */
  assets: readonly PriceBackfillCandidateAsset[];
  /** Every investment operation across all assets (any order). */
  operations: readonly InvestmentOperation[];
  /** Every frozen snapshot holding row across scopes (any order). */
  snapshotRows: readonly PriceBackfillSnapshotRow[];
}

/** A row frozen at cost basis: units present, unit price absent. */
function isCostBasisRow(row: PriceBackfillSnapshotRow): boolean {
  return row.kind === "asset" && row.units !== undefined && row.unitPrice === undefined;
}

/**
 * Detect every investment that is a backfill candidate: it has a provider symbol,
 * at least one operation (to anchor the first date), and at least one historical
 * snapshot row frozen at cost basis. Returns one entry per qualifying asset, in
 * the input asset order, each carrying its first-operation date and the count of
 * DISTINCT cost-basis dates (months) — the audit figures the preview surfaces.
 */
export function detectPriceBackfillCandidates(
  input: DetectPriceBackfillInput,
): PriceBackfillCandidate[] {
  // First-operation date per asset (the min executedAt date), built once.
  const firstOpByAsset = new Map<string, string>();
  for (const op of input.operations) {
    const dateKey = op.executedAt.slice(0, 10);
    const current = firstOpByAsset.get(op.assetId);
    if (current === undefined || dateKey < current) {
      firstOpByAsset.set(op.assetId, dateKey);
    }
  }

  // Distinct cost-basis dates per asset (a date frozen at cost in any scope).
  const costDatesByAsset = new Map<string, Set<string>>();
  for (const row of input.snapshotRows) {
    if (!isCostBasisRow(row)) continue;
    let dates = costDatesByAsset.get(row.holdingId);
    if (dates === undefined) {
      dates = new Set();
      costDatesByAsset.set(row.holdingId, dates);
    }
    dates.add(row.dateKey);
  }

  const candidates: PriceBackfillCandidate[] = [];
  for (const asset of input.assets) {
    if (asset.providerSymbol === undefined || asset.providerSymbol === "") continue;

    const firstOperationDate = firstOpByAsset.get(asset.assetId);
    if (firstOperationDate === undefined) continue;

    const costDates = costDatesByAsset.get(asset.assetId);
    if (costDates === undefined || costDates.size === 0) continue;

    candidates.push({
      assetId: asset.assetId,
      firstOperationDate,
      monthsAtCost: costDates.size,
      priceProvider: asset.priceProvider,
      providerSymbol: asset.providerSymbol,
    });
  }

  return candidates;
}

/** The metadata a single investment contributes to backfill candidacy. */
export interface SingleAssetBackfillInput {
  assetId: string;
  priceProvider: InvestmentPriceProvider;
  /** Undefined/empty when no provider symbol is configured (→ never a candidate). */
  providerSymbol?: string;
  operations: readonly InvestmentOperation[];
  snapshotRows: readonly PriceBackfillSnapshotRow[];
}

/**
 * Detect candidacy for ONE investment, building the single-asset detection input
 * in one place. Both the editar page (which only needs the boolean) and the
 * backfill action (which needs the candidate) call this, so the input shape lives
 * once and cannot drift. Returns the candidate, or null when not eligible.
 */
export function detectSingleAssetBackfillCandidate(
  input: SingleAssetBackfillInput,
): PriceBackfillCandidate | null {
  const candidates = detectPriceBackfillCandidates({
    assets: [
      {
        assetId: input.assetId,
        priceProvider: input.priceProvider,
        ...(input.providerSymbol ? { providerSymbol: input.providerSymbol } : {}),
      },
    ],
    operations: input.operations,
    snapshotRows: input.snapshotRows,
  });
  return candidates[0] ?? null;
}
