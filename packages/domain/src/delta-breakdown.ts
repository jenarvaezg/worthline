/**
 * Delta breakdown ("Origen del cambio", PRD #653) — pure domain engine.
 *
 * Splits a scope's net-worth change between two snapshot dates into market
 * movement, recorded payouts, and net savings (the residual, may be negative).
 * Reads frozen holding rows, operations, and optional payout series only — never
 * writes history (ADR 0008).
 *
 * S1 (#667) ships the two-band path (market / net savings); S2 (#660) feeds
 * recorded payouts so the payout band is carved from the residual.
 */

import { multiplyToMinor } from "./decimal";
import type { ValuationMethod } from "./holding-valuation";
import type { InvestmentOperation } from "./investment-types";
import { allocateByBps } from "./money";
import type { DatedAmount } from "./payouts";
import type { SnapshotHoldingKind, SnapshotHoldingRow } from "./snapshot-holdings";
import { deriveConfirmedMonthlyCloseIds } from "./snapshot-policy";
import type { NetWorthSnapshot } from "./snapshot-types";
import type { OwnershipShare } from "./workspace-types";

export type DeltaBreakdownBandId = "market" | "payouts" | "netSavings";

export interface DeltaBreakdownBands {
  marketMinor: number;
  payoutsMinor: number;
  netSavingsMinor: number;
}

/** One monthly-close window with its three-band split, or a gap when not computable. */
export interface DeltaBreakdownPeriod {
  /** The later monthly close's calendar day (YYYY-MM-DD). */
  dateKey: string;
  monthKey: string;
  aggregateDeltaMinor: number;
  bands: DeltaBreakdownBands | null;
}

export interface DeltaBreakdownWindowInput {
  previousRows: readonly SnapshotHoldingRow[];
  currentRows: readonly SnapshotHoldingRow[];
  /** Exclusive lower bound of the window (YYYY-MM-DD). */
  windowStartExclusive: string;
  /** Inclusive upper bound of the window (YYYY-MM-DD). */
  windowEndInclusive: string;
  aggregateDeltaMinor: number;
  valuationMethodByHoldingId: ReadonlyMap<string, ValuationMethod>;
  operationsByHoldingId: ReadonlyMap<string, readonly InvestmentOperation[]>;
  payoutsByHolding: ReadonlyMap<string, readonly DatedAmount[]>;
  ownershipByHoldingId: ReadonlyMap<string, readonly OwnershipShare[]>;
  scopeMemberIds: ReadonlySet<string>;
}

export interface BuildMonthlyCloseBreakdownInput {
  snapshots: readonly NetWorthSnapshot[];
  holdingRowsBySnapshotId: ReadonlyMap<string, readonly SnapshotHoldingRow[]>;
  valuationMethodByHoldingId: ReadonlyMap<string, ValuationMethod>;
  operationsByHoldingId: ReadonlyMap<string, readonly InvestmentOperation[]>;
  payoutsByHolding: ReadonlyMap<string, readonly DatedAmount[]>;
  ownershipByHoldingId: ReadonlyMap<string, readonly OwnershipShare[]>;
  scopeMemberIds: ReadonlySet<string>;
  today: string;
}

function scopeShareBps(
  ownership: readonly OwnershipShare[],
  scopeMemberIds: ReadonlySet<string>,
): number {
  return ownership
    .filter((share) => scopeMemberIds.has(share.memberId))
    .reduce((sum, share) => sum + share.shareBps, 0);
}

function inWindow(
  dateISO: string,
  windowStartExclusive: string,
  windowEndInclusive: string,
): boolean {
  return dateISO > windowStartExclusive && dateISO <= windowEndInclusive;
}

function holdingContributionMinor(
  kind: SnapshotHoldingKind,
  previousValueMinor: number,
  currentValueMinor: number,
): number {
  const diff = currentValueMinor - previousValueMinor;
  return kind === "asset" ? diff : -diff;
}

function isModeledMethod(method: ValuationMethod): boolean {
  return method === "appreciating" || method === "amortized" || method === "anchored";
}

function scopedNetOperationsInWindow(
  operations: readonly InvestmentOperation[],
  windowStartExclusive: string,
  windowEndInclusive: string,
  shareBps: number,
): number {
  let netMinor = 0;
  for (const operation of operations) {
    const date = operation.executedAt.slice(0, 10);
    if (!inWindow(date, windowStartExclusive, windowEndInclusive)) continue;
    const grossMinor = multiplyToMinor(operation.units, operation.pricePerUnit);
    const signedMinor =
      operation.kind === "buy"
        ? grossMinor + operation.feesMinor
        : -(grossMinor - operation.feesMinor);
    netMinor += allocateByBps(signedMinor, shareBps);
  }
  return netMinor;
}

function scopedPayoutsInWindow(
  payouts: readonly DatedAmount[],
  windowStartExclusive: string,
  windowEndInclusive: string,
  shareBps: number,
): number {
  let totalMinor = 0;
  for (const payout of payouts) {
    if (!inWindow(payout.dateISO, windowStartExclusive, windowEndInclusive)) continue;
    totalMinor += allocateByBps(payout.amountMinor, shareBps);
  }
  return totalMinor;
}

function marketContributionMinor(
  method: ValuationMethod,
  contributionMinor: number,
  netOperationsMinor: number,
): number {
  if (method === "derived") {
    return contributionMinor - netOperationsMinor;
  }
  if (isModeledMethod(method)) {
    return contributionMinor;
  }
  return 0;
}

/**
 * Compute the three-band split for one window between two snapshot dates.
 * Reconciles exactly: market + payouts + netSavings = aggregateDelta.
 */
export function computeDeltaBreakdownWindow(
  input: DeltaBreakdownWindowInput,
): DeltaBreakdownBands {
  const previousById = new Map(input.previousRows.map((row) => [row.holdingId, row]));
  const currentById = new Map(input.currentRows.map((row) => [row.holdingId, row]));
  const holdingIds = new Set([...previousById.keys(), ...currentById.keys()]);

  let marketMinor = 0;
  let payoutsMinor = 0;

  for (const holdingId of holdingIds) {
    const previous = previousById.get(holdingId);
    const current = currentById.get(holdingId);
    const ref = current ?? previous;
    if (!ref) continue;

    const ownership = input.ownershipByHoldingId.get(holdingId) ?? [];
    const shareBps = scopeShareBps(ownership, input.scopeMemberIds);
    if (shareBps === 0) continue;

    const contributionMinor = holdingContributionMinor(
      ref.kind,
      previous?.valueMinor ?? 0,
      current?.valueMinor ?? 0,
    );
    const method = input.valuationMethodByHoldingId.get(holdingId) ?? "stored";
    const netOperationsMinor =
      method === "derived"
        ? scopedNetOperationsInWindow(
            input.operationsByHoldingId.get(holdingId) ?? [],
            input.windowStartExclusive,
            input.windowEndInclusive,
            shareBps,
          )
        : 0;

    marketMinor += marketContributionMinor(method, contributionMinor, netOperationsMinor);

    payoutsMinor += scopedPayoutsInWindow(
      input.payoutsByHolding.get(holdingId) ?? [],
      input.windowStartExclusive,
      input.windowEndInclusive,
      shareBps,
    );
  }

  // Payouts on holdings absent from both snapshots still count when scope-owned.
  for (const [holdingId, payouts] of input.payoutsByHolding) {
    if (holdingIds.has(holdingId)) continue;
    const shareBps = scopeShareBps(
      input.ownershipByHoldingId.get(holdingId) ?? [],
      input.scopeMemberIds,
    );
    if (shareBps === 0) continue;
    payoutsMinor += scopedPayoutsInWindow(
      payouts,
      input.windowStartExclusive,
      input.windowEndInclusive,
      shareBps,
    );
  }

  const netSavingsMinor = input.aggregateDeltaMinor - marketMinor - payoutsMinor;

  return { marketMinor, netSavingsMinor, payoutsMinor };
}

/**
 * Build the monthly-close breakdown series for /historico: one period per
 * confirmed close after the first, oldest→newest. Months without a computable
 * pair render as gaps (`bands: null`), never invented.
 */
export function buildMonthlyCloseBreakdownSeries(
  input: BuildMonthlyCloseBreakdownInput,
): DeltaBreakdownPeriod[] {
  const confirmedCloseIds = deriveConfirmedMonthlyCloseIds(input.snapshots, input.today);
  const confirmedCloses = [...input.snapshots]
    .filter((snapshot) => confirmedCloseIds.has(snapshot.id))
    .sort((left, right) => left.dateKey.localeCompare(right.dateKey));

  if (confirmedCloses.length < 2) {
    return [];
  }

  const periods: DeltaBreakdownPeriod[] = [];

  for (let index = 1; index < confirmedCloses.length; index += 1) {
    const previous = confirmedCloses[index - 1]!;
    const current = confirmedCloses[index]!;
    const previousRows = input.holdingRowsBySnapshotId.get(previous.id);
    const currentRows = input.holdingRowsBySnapshotId.get(current.id);
    const aggregateDeltaMinor =
      current.totalNetWorth.amountMinor - previous.totalNetWorth.amountMinor;

    if (!previousRows || !currentRows) {
      periods.push({
        aggregateDeltaMinor,
        bands: null,
        dateKey: current.dateKey,
        monthKey: current.monthKey,
      });
      continue;
    }

    const bands = computeDeltaBreakdownWindow({
      aggregateDeltaMinor,
      currentRows,
      operationsByHoldingId: input.operationsByHoldingId,
      ownershipByHoldingId: input.ownershipByHoldingId,
      payoutsByHolding: input.payoutsByHolding,
      previousRows,
      scopeMemberIds: input.scopeMemberIds,
      valuationMethodByHoldingId: input.valuationMethodByHoldingId,
      windowEndInclusive: current.dateKey,
      windowStartExclusive: previous.dateKey,
    });

    periods.push({
      aggregateDeltaMinor,
      bands,
      dateKey: current.dateKey,
      monthKey: current.monthKey,
    });
  }

  return periods;
}

/** Whether a period should render the payout band (S2 #660). */
export function periodShowsPayoutBand(period: DeltaBreakdownPeriod): boolean {
  return period.bands !== null && period.bands.payoutsMinor !== 0;
}
