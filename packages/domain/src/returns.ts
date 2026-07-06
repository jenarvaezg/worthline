import type { CurrencyCode, MoneyMinor } from "./money";

import { daysBetween } from "./dates";
import { multiplyToMinor } from "./decimal";
import type { InvestmentOperation } from "./investment-types";
import { money } from "./money";
import { deriveMonthlyCloses } from "./snapshot-policy";

/**
 * Investment return measures (#548, ADR 0040). Present-time, derived, and never
 * stored — the net-worth math never reads these figures. Two measures live here:
 *
 * - **Simple total gain**: realized + unrealized P/L in € and as a fraction of the
 *   total invested, with a CAGR only when the span reaches a year.
 * - **Money-weighted return (XIRR)**: the internal rate of return over the
 *   operation cashflows plus the current market value as a terminal inflow.
 * - **Time-weighted return (TWR)**: Modified Dietz over monthly closes, chained
 *   across the available snapshot span.
 *
 * The module is pure: it reads operations and an injected valuation date, so tests
 * are deterministic without touching the wall clock.
 */

/** Days per year used to convert a calendar span to the fractional exponent XIRR needs. */
const YEAR_DAYS = 365;

/**
 * A signed cashflow on a calendar day. Negative = money out (a buy), positive =
 * money in (a sell, or the current market value as a terminal flow). This is the
 * shared primitive both the simple gain and the IRR ride.
 */
export interface DatedCashflow {
  date: string;
  amountMinor: number;
}

/**
 * A distribution a holding paid its owner — a dividend, coupon, or rent (#657,
 * ADR 0054). Money in, dated: it rides the same signed-cashflow primitive as a
 * sell (positive = inflow), so a recorded payout enters the IRR and the realized
 * simple gain without ever touching a net-worth figure. Amounts are the positive
 * minor units the payout record carries.
 */
export interface DatedPayout {
  date: string;
  amountMinor: number;
}

/** Recorded payouts as positive dated inflows (a no-op for an empty/absent series). */
export function payoutCashflows(
  payouts: readonly DatedPayout[] | undefined,
): DatedCashflow[] {
  return (payouts ?? []).map((payout) => ({
    amountMinor: payout.amountMinor,
    date: payout.date,
  }));
}

/** Why an IRR could not be computed — returned instead of a bogus rate. */
export type IrrReason =
  | "insufficient_cashflows"
  | "single_sign"
  | "zero_time_span"
  | "no_convergence";

/** An IRR result: a rate (annual, as a fraction) or null with the reason it failed. */
export interface IrrResult {
  rate: number | null;
  reason: IrrReason | null;
}

/** Simple (not-time-weighted) total gain over the holding's life. */
export interface SimpleGain {
  /** realized + unrealized P/L in € (minor units). */
  totalGain: MoneyMinor;
  /** Sum of every buy's cost (units × price + fees) — the denominator for the ratio. */
  totalInvestedMinor: number;
  /** totalGain / totalInvested, or null when nothing was invested. */
  totalReturnRatio: number | null;
  /** Calendar days from the first operation to the valuation date. */
  spanDays: number;
  /** Whether the span reached a year, so a CAGR is meaningful. */
  annualized: boolean;
  /** Compound annual growth rate, only when annualized; null for sub-year spans. */
  cagr: number | null;
}

/** A single holding's operation ledger plus its current market value. */
export interface HoldingReturnsInput {
  operations: readonly InvestmentOperation[];
  currency: CurrencyCode;
  /** Current market value in minor units (0 when fully sold or unpriced). */
  marketValueMinor: number;
  /** The "today" the terminal flow is dated at — injected so tests stay deterministic. */
  valuationDate: string;
  /** Recorded distributions (dividends/coupons/rent), folded as inflows (#657). */
  payouts?: readonly DatedPayout[];
}

/** A holding in a portfolio-level aggregation. */
export interface PortfolioHolding {
  operations: readonly InvestmentOperation[];
  marketValueMinor: number;
  /** Recorded distributions folded into the merged portfolio cashflows (#657). */
  payouts?: readonly DatedPayout[];
}

/** The holdings whose returns are aggregated into one portfolio figure. */
export interface PortfolioReturnsInput {
  holdings: readonly PortfolioHolding[];
  currency: CurrencyCode;
  valuationDate: string;
}

/** One monthly-close value in the series TWR can honestly compute from. */
export interface MonthlyCloseValue {
  date: string;
  valueMinor: number;
}

export interface MonthlyCloseSnapshotRow {
  snapshotId: string;
  dateKey: string;
  valueMinor: number;
}

/**
 * A cashflow into the measured holding/portfolio. Positive = contribution/buy,
 * negative = withdrawal/sell. This is the opposite sign of XIRR cashflows.
 */
export interface TwrCashflow {
  date: string;
  amountMinor: number;
}

/** Why a TWR could not be computed — returned instead of a bogus rate. */
export type TwrReason =
  | "insufficient_monthly_closes"
  | "zero_time_span"
  | "zero_denominator";

/** Time-weighted return over the available monthly-close span. */
export interface TwrResult {
  rate: number | null;
  annualizedRate: number | null;
  annualized: boolean;
  startDate: string | null;
  endDate: string | null;
  spanDays: number;
  reason: TwrReason | null;
}

export interface TimeWeightedReturnInput {
  monthlyCloses: readonly MonthlyCloseValue[];
  cashflows: readonly TwrCashflow[];
}

export interface HoldingTwrInput {
  operations: readonly InvestmentOperation[];
  monthlyCloses: readonly MonthlyCloseValue[];
}

export interface PortfolioTwrInput {
  holdings: readonly { operations: readonly InvestmentOperation[] }[];
  monthlyCloses: readonly MonthlyCloseValue[];
}

function byExecutedAtThenId(
  left: InvestmentOperation,
  right: InvestmentOperation,
): number {
  return left.executedAt === right.executedAt
    ? left.id.localeCompare(right.id)
    : left.executedAt.localeCompare(right.executedAt);
}

/**
 * The operation ledger as signed, dated cashflows, oldest first: a buy is
 * −(units × price + fees), a sell is +(units × price − fees).
 */
export function operationCashflows(
  operations: readonly InvestmentOperation[],
): DatedCashflow[] {
  return [...operations].sort(byExecutedAtThenId).map((operation) => {
    const gross = multiplyToMinor(operation.units, operation.pricePerUnit);
    const amountMinor =
      operation.kind === "buy"
        ? -(gross + operation.feesMinor)
        : gross - operation.feesMinor;
    return { amountMinor, date: operation.executedAt.slice(0, 10) };
  });
}

export function operationTwrCashflows(
  operations: readonly InvestmentOperation[],
): TwrCashflow[] {
  return operationCashflows(operations).map((cashflow) => ({
    amountMinor: -cashflow.amountMinor,
    date: cashflow.date,
  }));
}

export function monthlyCloseValuesFromSnapshotRows(
  rows: readonly MonthlyCloseSnapshotRow[],
): MonthlyCloseValue[] {
  const closeIds = new Set(
    deriveMonthlyCloses(
      rows.map((row) => ({
        dateKey: row.dateKey,
        id: row.snapshotId,
        monthKey: row.dateKey.slice(0, 7),
        scopeId: "returns",
      })),
    ).values(),
  );

  return rows
    .filter((row) => closeIds.has(row.snapshotId))
    .map((row) => ({ date: row.dateKey, valueMinor: row.valueMinor }))
    .sort((left, right) => left.date.localeCompare(right.date));
}

export function timeWeightedReturn(input: TimeWeightedReturnInput): TwrResult {
  const monthlyCloses = [...input.monthlyCloses].sort((left, right) =>
    left.date.localeCompare(right.date),
  );

  if (monthlyCloses.length < 2) {
    return {
      annualized: false,
      annualizedRate: null,
      endDate: monthlyCloses[0]?.date ?? null,
      rate: null,
      reason: "insufficient_monthly_closes",
      spanDays: 0,
      startDate: monthlyCloses[0]?.date ?? null,
    };
  }

  const startDate = monthlyCloses[0]!.date;
  const endDate = monthlyCloses[monthlyCloses.length - 1]!.date;
  const spanDays = daysBetween(startDate, endDate);

  if (spanDays <= 0) {
    return {
      annualized: false,
      annualizedRate: null,
      endDate,
      rate: null,
      reason: "zero_time_span",
      spanDays,
      startDate,
    };
  }

  let factor = 1;
  for (let index = 1; index < monthlyCloses.length; index += 1) {
    const start = monthlyCloses[index - 1]!;
    const end = monthlyCloses[index]!;
    const periodDays = daysBetween(start.date, end.date);

    if (periodDays <= 0) {
      return {
        annualized: false,
        annualizedRate: null,
        endDate,
        rate: null,
        reason: "zero_time_span",
        spanDays,
        startDate,
      };
    }

    const periodCashflows = input.cashflows.filter(
      (cashflow) => cashflow.date > start.date && cashflow.date <= end.date,
    );
    const totalCashflowMinor = periodCashflows.reduce(
      (sum, cashflow) => sum + cashflow.amountMinor,
      0,
    );
    const weightedCashflowMinor = periodCashflows.reduce(
      (sum, cashflow) =>
        sum + cashflow.amountMinor * (daysBetween(cashflow.date, end.date) / periodDays),
      0,
    );
    const denominator = start.valueMinor + weightedCashflowMinor;

    if (denominator === 0) {
      return {
        annualized: false,
        annualizedRate: null,
        endDate,
        rate: null,
        reason: "zero_denominator",
        spanDays,
        startDate,
      };
    }

    const periodRate =
      (end.valueMinor - start.valueMinor - totalCashflowMinor) / denominator;
    factor *= 1 + periodRate;
  }

  const rate = factor - 1;
  const annualized = spanDays >= YEAR_DAYS;
  const annualizedRate =
    annualized && factor > 0 ? factor ** (YEAR_DAYS / spanDays) - 1 : null;

  return {
    annualized,
    annualizedRate,
    endDate,
    rate,
    reason: null,
    spanDays,
    startDate,
  };
}

export function holdingTwr(input: HoldingTwrInput): TwrResult {
  return timeWeightedReturn({
    cashflows: operationTwrCashflows(input.operations),
    monthlyCloses: input.monthlyCloses,
  });
}

export function portfolioTwr(input: PortfolioTwrInput): TwrResult {
  return timeWeightedReturn({
    cashflows: input.holdings.flatMap((holding) =>
      operationTwrCashflows(holding.operations),
    ),
    monthlyCloses: input.monthlyCloses,
  });
}

interface YearedFlow {
  years: number;
  amount: number;
}

function netPresentValue(flows: readonly YearedFlow[], rate: number): number {
  return flows.reduce((sum, flow) => sum + flow.amount / (1 + rate) ** flow.years, 0);
}

function netPresentValueDerivative(flows: readonly YearedFlow[], rate: number): number {
  return flows.reduce(
    (sum, flow) => sum - (flow.years * flow.amount) / (1 + rate) ** (flow.years + 1),
    0,
  );
}

/**
 * Bisection fallback: scan (−1, +∞) for a sign change of NPV, then bisect it.
 * Returns null when no bracket is found in the search range.
 */
function bisectIrr(flows: readonly YearedFlow[]): number | null {
  let previous = -0.999_999;
  let previousValue = netPresentValue(flows, previous);

  const scan = (from: number, to: number, step: number): number | null => {
    for (let rate = from; rate <= to; rate += step) {
      const value = netPresentValue(flows, rate);
      if (
        Number.isFinite(previousValue) &&
        Number.isFinite(value) &&
        previousValue * value < 0
      ) {
        return refine(flows, previous, previousValue, rate);
      }
      previous = rate;
      previousValue = value;
    }
    return null;
  };

  return scan(-0.99, 10, 0.001) ?? scan(10, 1_000, 1);
}

function refine(
  flows: readonly YearedFlow[],
  lowRate: number,
  lowValue: number,
  highRate: number,
): number {
  let low = lowRate;
  let high = highRate;
  let lowVal = lowValue;

  for (let iteration = 0; iteration < 200; iteration += 1) {
    const mid = (low + high) / 2;
    const midVal = netPresentValue(flows, mid);
    if (Math.abs(midVal) < 1e-7 || (high - low) / 2 < 1e-12) {
      return mid;
    }
    if (lowVal * midVal < 0) {
      high = mid;
    } else {
      low = mid;
      lowVal = midVal;
    }
  }

  return (low + high) / 2;
}

/**
 * Money-weighted return (XIRR) over dated cashflows. Newton-Raphson from a 10%
 * guess with a bisection fallback for robustness. Edge cases return null with a
 * reason rather than a bogus rate: fewer than two flows, flows that never change
 * sign (no root), or flows that span no time.
 */
export function xirr(cashflows: readonly DatedCashflow[]): IrrResult {
  if (cashflows.length < 2) {
    return { rate: null, reason: "insufficient_cashflows" };
  }

  const hasInflow = cashflows.some((flow) => flow.amountMinor > 0);
  const hasOutflow = cashflows.some((flow) => flow.amountMinor < 0);
  if (!hasInflow || !hasOutflow) {
    return { rate: null, reason: "single_sign" };
  }

  const base = cashflows.reduce(
    (earliest, flow) => (flow.date < earliest ? flow.date : earliest),
    cashflows[0]!.date,
  );
  const latest = cashflows.reduce(
    (last, flow) => (flow.date > last ? flow.date : last),
    cashflows[0]!.date,
  );
  if (daysBetween(base, latest) === 0) {
    return { rate: null, reason: "zero_time_span" };
  }

  const flows: YearedFlow[] = cashflows.map((flow) => ({
    amount: flow.amountMinor,
    years: daysBetween(base, flow.date) / YEAR_DAYS,
  }));

  // Newton-Raphson.
  let rate = 0.1;
  for (let iteration = 0; iteration < 100; iteration += 1) {
    const value = netPresentValue(flows, rate);
    const derivative = netPresentValueDerivative(flows, rate);
    if (!Number.isFinite(value) || !Number.isFinite(derivative) || derivative === 0) {
      break;
    }
    const next = rate - value / derivative;
    if (!Number.isFinite(next) || next <= -1) {
      break;
    }
    if (Math.abs(next - rate) < 1e-9) {
      return { rate: next, reason: null };
    }
    rate = next;
  }

  const bracketed = bisectIrr(flows);
  return bracketed === null
    ? { rate: null, reason: "no_convergence" }
    : { rate: bracketed, reason: null };
}

function simpleGainFromFlows(
  flows: readonly DatedCashflow[],
  marketValueMinor: number,
  currency: CurrencyCode,
  firstDate: string | null,
  valuationDate: string,
): SimpleGain {
  const totalInvestedMinor = flows.reduce(
    (sum, flow) => (flow.amountMinor < 0 ? sum - flow.amountMinor : sum),
    0,
  );
  const proceedsMinor = flows.reduce(
    (sum, flow) => (flow.amountMinor > 0 ? sum + flow.amountMinor : sum),
    0,
  );
  const totalGainMinor = proceedsMinor + marketValueMinor - totalInvestedMinor;
  const totalReturnRatio =
    totalInvestedMinor > 0 ? totalGainMinor / totalInvestedMinor : null;

  const spanDays = firstDate ? daysBetween(firstDate, valuationDate) : 0;
  const annualized = spanDays >= YEAR_DAYS;
  const cagr =
    annualized && totalReturnRatio !== null
      ? (1 + totalReturnRatio) ** (YEAR_DAYS / spanDays) - 1
      : null;

  return {
    annualized,
    cagr,
    spanDays,
    totalGain: money(totalGainMinor, currency),
    totalInvestedMinor,
    totalReturnRatio,
  };
}

/**
 * Simple total gain for one holding: realized + unrealized P/L (equivalently, the
 * sum of every cashflow including the terminal market value) over the total
 * invested, with a CAGR only when the span reaches a year.
 */
export function simpleGain(input: HoldingReturnsInput): SimpleGain {
  const operationFlows = operationCashflows(input.operations);
  const flows = [...operationFlows, ...payoutCashflows(input.payouts)];
  return simpleGainFromFlows(
    flows,
    input.marketValueMinor,
    input.currency,
    // Span runs from the first operation (holding life), not a later payout.
    operationFlows[0]?.date ?? flows[0]?.date ?? null,
    input.valuationDate,
  );
}

/**
 * Simple total gain from an already-built (possibly merged) cashflow stream plus a
 * terminal market value — the entry point used when the flows are pre-scaled (e.g.
 * per-asset-class attribution, #552), where operations no longer map one-to-one to
 * a single holding. The span runs from the earliest flow to the valuation date.
 */
export function simpleGainFromCashflows(input: {
  cashflows: readonly DatedCashflow[];
  marketValueMinor: number;
  currency: CurrencyCode;
  valuationDate: string;
}): SimpleGain {
  const sorted = [...input.cashflows].sort((left, right) =>
    left.date.localeCompare(right.date),
  );
  return simpleGainFromFlows(
    sorted,
    input.marketValueMinor,
    input.currency,
    sorted[0]?.date ?? null,
    input.valuationDate,
  );
}

/** Build a holding's full cashflow stream: operations plus the terminal market value. */
function holdingCashflows(
  input: HoldingReturnsInput | PortfolioHolding,
  valuationDate: string,
): DatedCashflow[] {
  const flows = operationCashflows(input.operations);
  flows.push(...payoutCashflows(input.payouts));
  if (input.marketValueMinor > 0) {
    flows.push({ amountMinor: input.marketValueMinor, date: valuationDate });
  }
  return flows;
}

/**
 * Money-weighted return for one holding: XIRR over its operation cashflows plus
 * the current market value as a terminal inflow at the valuation date.
 */
export function holdingIrr(input: HoldingReturnsInput): IrrResult {
  return xirr(holdingCashflows(input, input.valuationDate));
}

/** Portfolio simple gain: sum invested and gain across holdings; CAGR over the whole span. */
export function portfolioSimpleGain(input: PortfolioReturnsInput): SimpleGain {
  let totalInvestedMinor = 0;
  let totalGainMinor = 0;
  let earliestDate: string | null = null;

  for (const holding of input.holdings) {
    const operationFlows = operationCashflows(holding.operations);
    const flows = [...operationFlows, ...payoutCashflows(holding.payouts)];
    const gain = simpleGainFromFlows(
      flows,
      holding.marketValueMinor,
      input.currency,
      operationFlows[0]?.date ?? flows[0]?.date ?? null,
      input.valuationDate,
    );
    totalInvestedMinor += gain.totalInvestedMinor;
    totalGainMinor += gain.totalGain.amountMinor;
    const first = operationFlows[0]?.date;
    if (first && (earliestDate === null || first < earliestDate)) {
      earliestDate = first;
    }
  }

  const totalReturnRatio =
    totalInvestedMinor > 0 ? totalGainMinor / totalInvestedMinor : null;
  const spanDays = earliestDate ? daysBetween(earliestDate, input.valuationDate) : 0;
  const annualized = spanDays >= YEAR_DAYS;
  const cagr =
    annualized && totalReturnRatio !== null
      ? (1 + totalReturnRatio) ** (YEAR_DAYS / spanDays) - 1
      : null;

  return {
    annualized,
    cagr,
    spanDays,
    totalGain: money(totalGainMinor, input.currency),
    totalInvestedMinor,
    totalReturnRatio,
  };
}

/**
 * Portfolio money-weighted return: every holding's cashflows (operations plus its
 * terminal market value) merged into one dated stream, then XIRR.
 */
export function portfolioIrr(input: PortfolioReturnsInput): IrrResult {
  const merged: DatedCashflow[] = [];
  for (const holding of input.holdings) {
    merged.push(...holdingCashflows(holding, input.valuationDate));
  }
  return xirr(merged);
}
