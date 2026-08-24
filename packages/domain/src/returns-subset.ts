import type { InvestmentOperation } from "./investment-types";
import type { CurrencyCode } from "./money";
import { allocateByBps } from "./money";
import type {
  DatedCashflow,
  DatedPayout,
  IrrResult,
  MonthlyCloseValue,
  SimpleGain,
  TwrCashflow,
  TwrResult,
} from "./returns";
import {
  operationCashflows,
  operationTwrCashflows,
  payoutCashflows,
  simpleGainFromCashflows,
  timeWeightedReturn,
  xirr,
} from "./returns";

/**
 * The returns of an arbitrary SUBSET of holdings — the one aggregation both the
 * per-asset-class decomposition (#552) and the managed portfolio's own return
 * (#1552, ADR 0085) ride.
 *
 * It was extracted from `returns-by-class` rather than written beside it: a
 * cartera's «+11,32 %» and a class's «+11,32 %» answer the same question about a
 * different subset, and two engines for one question is exactly how two surfaces
 * end up disagreeing about the same money (#1422). Everything here delegates to
 * the proven pure engines in `returns`; what this module owns is how the slices
 * are SCALED, MERGED and ALIGNED before they get there.
 *
 * Three rules it exists to hold in one place:
 *
 * - **The double scaling.** A slice's cashflows are scaled by the owner's share
 *   (`ownershipBps`) and then by the slice's share of the subset (`shareBps`);
 *   its value and monthly closes arrive ALREADY on the caller's chosen basis, so
 *   only `shareBps` applies to them. Keeping the three inputs on one basis is what
 *   makes the resulting simple gain / IRR internally consistent.
 * - **Same-day flows are netted.** Money that only moved BETWEEN members of the
 *   subset is not capital the subset received: a traspaso's two halves are equal
 *   and opposite on the same date (ADR 0082), so netting per day cancels them and
 *   leaves only what a fee actually took. Without it the pair still cancels in the
 *   gain but INFLATES the denominator, and a portfolio that never received a cent
 *   from outside reads as if it had been funded twice.
 * - **Monthly closes align by calendar month**, never by exact date — the
 *   sawtooth of #1457, documented at {@link alignMonthlyCloses}.
 */

/** A whole share: the default for both scalings. */
export const FULL_SHARE_BPS = 10_000;

/** One holding's contribution to a subset: its ledger, its value, its weights. */
export interface SubsetReturnsSlice {
  operations: readonly InvestmentOperation[];
  /** Current market value in minor units (0 when fully sold or unpriced). */
  marketValueMinor: number;
  /**
   * This holding's monthly-close value series (for TWR); empty when unavailable.
   * Must be on the SAME basis as `marketValueMinor` (both gross, or both scoped).
   */
  monthlyCloses: readonly MonthlyCloseValue[];
  /**
   * The owner's share in basis points (default whole), applied to the operation
   * cashflows BEFORE {@link shareBps}. `marketValueMinor` / `monthlyCloses` must
   * ALREADY be on the caller's chosen basis.
   */
  ownershipBps?: number;
  /**
   * This slice's share of the subset in basis points (default whole), applied to
   * the cashflows, the value AND the monthly closes. The per-class decomposition
   * passes the class weight here; a subset that takes its members whole (a
   * managed portfolio) leaves it out.
   */
  shareBps?: number;
  /**
   * Recorded distributions (dividends/coupons/rent, #657), scaled exactly like
   * the operation cashflows so the subset's simple gain / IRR stays coherent
   * with the per-holding measures.
   */
  payouts?: readonly DatedPayout[];
}

/** What a subset of holdings is worth, and how it has done. */
export interface SubsetReturns {
  /** The value attributed to the subset today, after both scalings. */
  marketValueMinor: number;
  simpleGain: SimpleGain;
  irr: IrrResult;
  twr: TwrResult;
  /** Whether any recorded payout was folded in (#657) — so no subset claims
   *  income it never received. */
  payoutsIncluded: boolean;
}

/** One slice's scaled monthly closes, plus whether it is still held. */
interface HoldingCloseSeries {
  closes: readonly MonthlyCloseValue[];
  /** A holding with value today is still in the subset even if its last close is missing. */
  stillHeld: boolean;
}

export function subsetReturns(input: {
  slices: readonly SubsetReturnsSlice[];
  currency: CurrencyCode;
  valuationDate: string;
}): SubsetReturns {
  const cashflows: DatedCashflow[] = [];
  const twrCashflows: TwrCashflow[] = [];
  const monthlySeries: HoldingCloseSeries[] = [];
  let marketValueMinor = 0;
  let payoutsIncluded = false;

  for (const slice of input.slices) {
    const ownershipBps = slice.ownershipBps ?? FULL_SHARE_BPS;
    const shareBps = slice.shareBps ?? FULL_SHARE_BPS;
    // Ownership scales the operation cashflows to the owned slice (mirroring the
    // portfolio block's per-flow scaling); the value and the closes arrive already
    // on the caller's basis, so only the subset share applies to them below.
    // Operations and recorded payouts share one signed stream (a payout is a
    // positive inflow); TWR excludes payouts (#657 scope) and stays on operations.
    const scaleFlow = (amountMinor: number): number =>
      allocateByBps(allocateByBps(amountMinor, ownershipBps), shareBps);

    if ((slice.payouts?.length ?? 0) > 0) {
      payoutsIncluded = true;
    }

    for (const flow of [
      ...operationCashflows(slice.operations),
      ...payoutCashflows(slice.payouts),
    ]) {
      cashflows.push({ amountMinor: scaleFlow(flow.amountMinor), date: flow.date });
    }

    marketValueMinor += allocateByBps(slice.marketValueMinor, shareBps);

    // TWR measures a value series, so series AND flows must describe the same set
    // of holdings: one with no monthly closes — an alta from today, absent from
    // every capture so far — contributes neither. Letting its purchase in as a
    // flow with no value behind it drags the whole measure under (#1457).
    if (slice.monthlyCloses.length === 0) {
      continue;
    }
    for (const flow of operationTwrCashflows(slice.operations)) {
      twrCashflows.push({ amountMinor: scaleFlow(flow.amountMinor), date: flow.date });
    }
    monthlySeries.push({
      closes: slice.monthlyCloses.map((close) => ({
        date: close.date,
        valueMinor: allocateByBps(close.valueMinor, shareBps),
      })),
      stillHeld: slice.marketValueMinor > 0,
    });
  }

  const netCashflows = netByDate(cashflows);

  return {
    irr: xirr([
      ...netCashflows,
      ...(marketValueMinor > 0
        ? [{ amountMinor: marketValueMinor, date: input.valuationDate }]
        : []),
    ]),
    marketValueMinor,
    payoutsIncluded,
    simpleGain: simpleGainFromCashflows({
      cashflows: netCashflows,
      currency: input.currency,
      marketValueMinor,
      valuationDate: input.valuationDate,
    }),
    twr: timeWeightedReturn({
      cashflows: netByDate(twrCashflows),
      monthlyCloses: alignMonthlyCloses(monthlySeries),
    }),
  };
}

/**
 * One net flow per day: what the subset actually received from — or returned to —
 * the outside world that day.
 *
 * A traspaso between two members is money leaving one and arriving at the other on
 * the same date (ADR 0082), and the subset holds both halves, so the day nets to
 * whatever the fee took and nothing else. The simple gain reads its denominator
 * from the NEGATIVE flows alone, so without this the pair would count as fresh
 * capital in and proceeds out — the gain unchanged, the return ratio halved.
 *
 * A day that nets to exactly zero keeps its (zero) entry rather than disappearing:
 * it is a real day of the subset's life, and dropping it would move the span the
 * simple gain and the IRR are measured over. A zero contributes nothing to either.
 */
function netByDate<T extends { date: string; amountMinor: number }>(
  flows: readonly T[],
): Array<{ date: string; amountMinor: number }> {
  const byDate = new Map<string, number>();
  for (const flow of flows) {
    byDate.set(flow.date, (byDate.get(flow.date) ?? 0) + flow.amountMinor);
  }
  return [...byDate.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([date, amountMinor]) => ({ amountMinor, date }));
}

/** The "YYYY-MM" a close belongs to — the granularity a monthly close really has. */
function monthKeyOf(date: string): string {
  return date.slice(0, 7);
}

/**
 * The subset's monthly-close series from its holdings' own series, aligned by
 * CALENDAR MONTH rather than by exact date.
 *
 * A monthly close means "what this holding was worth at the end of month M", and
 * each holding derives its own from the snapshot rows it appears in — so the day
 * carrying that close can differ between holdings of the same subset. Summing by
 * exact date makes every such day a partial sum of the subset, which is the
 * sawtooth #1457 reproduced.
 *
 * Per month the series takes the latest close date any holding reports (the
 * month's close) and sums, for every holding, its close for that month — or, when
 * a month is missing from its series, the last value it is known to have had.
 *
 * A holding stops contributing only once it has LEFT the subset — and the signal
 * for that is having no value today, not a missing last close. A best-effort
 * capture can skip the final pass for a holding that is still held (#1339); reading
 * that as an exit would drop its value with no sell to offset it. A holding that is
 * genuinely gone (sold, transferred away) has no value left, and its sell sits in
 * the TWR cashflows, so Modified Dietz reads the step as a flow, not a price move.
 */
function alignMonthlyCloses(series: readonly HoldingCloseSeries[]): MonthlyCloseValue[] {
  const slices = series
    .filter((slice) => slice.closes.length > 0)
    .map((slice) => {
      const byMonth = new Map<string, MonthlyCloseValue>();
      // Ascending, so the month's last close wins.
      for (const close of [...slice.closes].sort((left, right) =>
        left.date.localeCompare(right.date),
      )) {
        byMonth.set(monthKeyOf(close.date), close);
      }
      const monthKeys = [...byMonth.keys()];
      return {
        byMonth,
        carried: null as number | null,
        lastMonth: monthKeys[monthKeys.length - 1]!,
        stillHeld: slice.stillHeld,
      };
    });

  const months = [
    ...new Set(slices.flatMap((slice) => [...slice.byMonth.keys()])),
  ].sort();

  return months.map((month) => {
    let date = `${month}-01`;
    let valueMinor = 0;
    for (const slice of slices) {
      const close = slice.byMonth.get(month);
      if (close) {
        slice.carried = close.valueMinor;
        if (close.date > date) {
          date = close.date;
        }
      } else if (!slice.stillHeld && month > slice.lastMonth) {
        slice.carried = null;
      }
      valueMinor += slice.carried ?? 0;
    }
    return { date, valueMinor };
  });
}
