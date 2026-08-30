import type { DecimalString } from "./decimal";
import { scaleMinorByWeight } from "./decimal";
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
 *   (`ownershipBps`) and then by the slice's share of the subset ({@link
 *   SubsetReturnsSlice.share}); its monthly closes arrive on the caller's chosen
 *   basis and take only the subset share. Its market VALUE arrives already
 *   attributed: a value is the one figure two surfaces reconcile to the céntimo,
 *   and the split that gets it there spans every bucket of the holding at once
 *   (`splitMinorByWeights`, #1610) — something no single slice can see from in
 *   here. Keeping the three inputs on one basis is what makes the resulting
 *   simple gain / IRR internally consistent.
 * - **An internal traspaso is netted into one residual flow.** Money that only
 *   moved BETWEEN members of the subset is not capital the subset received. The
 *   two halves share a `transferId` (ADR 0082) and are equal and opposite, so when
 *   BOTH are inside the subset they collapse into a single flow worth whatever the
 *   fee took — dated at the earlier half, which is when the money actually left.
 *   Without it the pair still cancels in the gain but INFLATES the denominator,
 *   and a portfolio that never received a cent from outside reads as if it had
 *   been funded twice. The pairing is by `transferId` and never by DATE: two
 *   unrelated flows that happen to fall on one day are two real movements, and a
 *   half whose counterpart lives outside the subset is real capital arriving or
 *   leaving.
 * - **Monthly closes align by calendar month**, never by exact date — the
 *   sawtooth of #1457, documented at {@link alignMonthlyCloses}.
 */

/** A whole ownership share: the default when a caller declares none. */
export const FULL_SHARE_BPS = 10_000;

/** One holding's contribution to a subset: its ledger, its value, its weights. */
export interface SubsetReturnsSlice {
  operations: readonly InvestmentOperation[];
  /**
   * The market value ATTRIBUTED to this slice, in minor units (0 when fully sold,
   * unpriced, or when the slice's share of the holding rounds to nothing). It is
   * taken as given: a subset that holds its members whole passes the holding's
   * value, and one that takes a fraction of them passes the céntimos its
   * canonical split awarded this bucket — {@link share} never re-derives it.
   */
  marketValueMinor: number;
  /**
   * This holding's monthly-close value series (for TWR); empty when unavailable.
   * Must be on the SAME basis as `marketValueMinor` before {@link share} applies
   * (both gross, or both scoped).
   */
  monthlyCloses: readonly MonthlyCloseValue[];
  /**
   * The owner's share in basis points (default whole), applied to the operation
   * cashflows BEFORE {@link share}. `monthlyCloses` must ALREADY be on the
   * caller's chosen basis.
   */
  ownershipBps?: number;
  /**
   * This slice's share of the subset as an exact decimal weight (default whole),
   * applied to the cashflows and the monthly closes — never to the value, which
   * the caller has already attributed. The per-class decomposition passes the
   * class weight here; a subset that takes its members whole (a managed
   * portfolio) leaves it out.
   *
   * A decimal and not basis points: the weight has ONE spelling (#1610), the same
   * one the céntimo split reads, so the ledger a class measures and the value it
   * reports cannot drift apart at the fourth decimal.
   */
  share?: DecimalString;
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
  /**
   * What SELLS returned to the pocket over the subset's life, after internal
   * traspasos are netted away. Payouts are deliberately not in it: a surface that
   * says "there have been reembolsos" must not say it because a dividend was
   * recorded.
   */
  sellProceedsMinor: number;
}

/** One slice's scaled monthly closes, plus whether it is still held. */
interface HoldingCloseSeries {
  closes: readonly MonthlyCloseValue[];
  /**
   * A holding with value today is still in the subset even if its last close is
   * missing. Read off the ATTRIBUTED value (#1610), so it answers the question
   * the series actually needs: does this slice still hold anything HERE. A class
   * whose weight is too small to be worth a céntimo holds nothing in that class,
   * and its carried-forward close was already rounding to zero.
   */
  stillHeld: boolean;
}

export function subsetReturns(input: {
  slices: readonly SubsetReturnsSlice[];
  currency: CurrencyCode;
  valuationDate: string;
}): SubsetReturns {
  // The traspasos whose BOTH halves live inside this subset: only those describe
  // money moving internally. One half alone is real capital arriving from — or
  // leaving to — somewhere else, and it stays a flow.
  const internalTransferIds = internalTransfers(input.slices);

  const cashflows: DatedCashflow[] = [];
  const twrCashflows: TwrCashflow[] = [];
  const monthlySeries: HoldingCloseSeries[] = [];
  // One residual per internal traspaso: its two halves add up to whatever the fee
  // took (zero when there was none), dated at the earlier half.
  const residuals = new Map<string, TransferResidual>();
  const twrResiduals = new Map<string, TransferResidual>();
  let marketValueMinor = 0;
  let payoutsIncluded = false;
  let sellProceedsMinor = 0;

  for (const slice of input.slices) {
    const ownershipBps = slice.ownershipBps ?? FULL_SHARE_BPS;
    const share = slice.share;
    // A whole slice short-circuits the decimal seam: the subsets that take their
    // members whole (a cartera, the book) are the hot path, and `× 1` is work.
    const scaleShare =
      share === undefined
        ? (amountMinor: number): number => amountMinor
        : (amountMinor: number): number => scaleMinorByWeight(amountMinor, share);
    // Ownership scales the operation cashflows to the owned slice (mirroring the
    // portfolio block's per-flow scaling); the closes arrive already on the
    // caller's basis, so only the subset share applies to them below.
    // Operations and recorded payouts share one signed stream (a payout is a
    // positive inflow); TWR excludes payouts (#657 scope) and stays on operations.
    const scaleFlow = (amountMinor: number): number =>
      scaleShare(allocateByBps(amountMinor, ownershipBps));

    if ((slice.payouts?.length ?? 0) > 0) {
      payoutsIncluded = true;
    }

    // The ledger is split BEFORE it is turned into flows, so the sign of every kind
    // stays `operationCashflows`' business alone (`signedInvestedMinor`'s one home)
    // and nothing here re-spells it. An internal half is folded through the very
    // same function, one operation at a time, to keep its residual attributable.
    const { external, internal } = splitInternalHalves(
      slice.operations,
      internalTransferIds,
    );

    for (const flow of operationCashflows(external)) {
      const amountMinor = scaleFlow(flow.amountMinor);
      if (amountMinor > 0) {
        sellProceedsMinor += amountMinor;
      }
      cashflows.push({ amountMinor, date: flow.date });
    }
    for (const operation of internal) {
      const flow = operationCashflows([operation])[0]!;
      foldResidual(
        residuals,
        operation.transferId!,
        scaleFlow(flow.amountMinor),
        flow.date,
      );
    }

    for (const flow of payoutCashflows(slice.payouts)) {
      cashflows.push({ amountMinor: scaleFlow(flow.amountMinor), date: flow.date });
    }

    marketValueMinor += slice.marketValueMinor;

    // TWR measures a value series, so series AND flows must describe the same set
    // of holdings: one with no monthly closes — an alta from today, absent from
    // every capture so far — contributes neither. Letting its purchase in as a
    // flow with no value behind it drags the whole measure under (#1457).
    if (slice.monthlyCloses.length === 0) {
      continue;
    }
    for (const flow of operationTwrCashflows(external)) {
      twrCashflows.push({ amountMinor: scaleFlow(flow.amountMinor), date: flow.date });
    }
    for (const operation of internal) {
      const flow = operationTwrCashflows([operation])[0]!;
      foldResidual(
        twrResiduals,
        operation.transferId!,
        scaleFlow(flow.amountMinor),
        flow.date,
      );
    }
    monthlySeries.push({
      closes: slice.monthlyCloses.map((close) => ({
        date: close.date,
        valueMinor: scaleShare(close.valueMinor),
      })),
      stillHeld: slice.marketValueMinor > 0,
    });
  }

  for (const residual of residuals.values()) {
    if (residual.amountMinor > 0) {
      sellProceedsMinor += residual.amountMinor;
    }
  }
  const allCashflows = withResiduals(cashflows, residuals);

  return {
    irr: xirr([
      ...allCashflows,
      ...(marketValueMinor > 0
        ? [{ amountMinor: marketValueMinor, date: input.valuationDate }]
        : []),
    ]),
    marketValueMinor,
    payoutsIncluded,
    sellProceedsMinor,
    simpleGain: simpleGainFromCashflows({
      cashflows: allCashflows,
      currency: input.currency,
      marketValueMinor,
      valuationDate: input.valuationDate,
    }),
    twr: timeWeightedReturn({
      cashflows: withResiduals(twrCashflows, twrResiduals),
      monthlyCloses: alignMonthlyCloses(monthlySeries),
    }),
  };
}

/** One internal traspaso collapsed into a single flow: what the fee took, and when. */
interface TransferResidual {
  amountMinor: number;
  date: string;
}

/**
 * The `transferId`s whose two halves are BOTH inside the subset — the only ones
 * that describe money moving internally.
 *
 * Counted per half rather than assumed from the id: a cartera can perfectly well
 * hold the ORIGIN of a traspaso whose destination lives outside it (a fund moved
 * out of the managed portfolio), and that is capital leaving, not an internal
 * move. Only a pair with both ends here nets.
 */
function internalTransfers(slices: readonly SubsetReturnsSlice[]): Set<string> {
  const halves = new Map<string, number>();
  for (const slice of slices) {
    for (const operation of slice.operations) {
      const transferId = operation.transferId;
      if (transferId === undefined) {
        continue;
      }
      halves.set(transferId, (halves.get(transferId) ?? 0) + 1);
    }
  }
  return new Set(
    [...halves.entries()].filter(([, count]) => count >= 2).map(([id]) => id),
  );
}

/** A holding's ledger split into the halves of an INTERNAL traspaso and the rest. */
function splitInternalHalves(
  operations: readonly InvestmentOperation[],
  internalTransferIds: ReadonlySet<string>,
): { external: InvestmentOperation[]; internal: InvestmentOperation[] } {
  const external: InvestmentOperation[] = [];
  const internal: InvestmentOperation[] = [];
  for (const operation of operations) {
    const transferId = operation.transferId;
    if (transferId !== undefined && internalTransferIds.has(transferId)) {
      internal.push(operation);
    } else {
      external.push(operation);
    }
  }
  return { external, internal };
}

/** Fold one half into its traspaso's residual, keeping the earlier of the two dates. */
function foldResidual(
  residuals: Map<string, TransferResidual>,
  transferId: string,
  amountMinor: number,
  date: string,
): void {
  const existing = residuals.get(transferId);
  if (existing === undefined) {
    residuals.set(transferId, { amountMinor, date });
    return;
  }
  existing.amountMinor += amountMinor;
  if (date < existing.date) {
    existing.date = date;
  }
}

/**
 * The flows plus every non-zero traspaso residual, oldest first.
 *
 * A residual worth nothing is dropped rather than carried as a 0 € flow: it moved
 * no money, and keeping it would let the date of a traspaso be read as the start
 * of the subset's measured life.
 */
function withResiduals(
  flows: readonly DatedCashflow[],
  residuals: ReadonlyMap<string, TransferResidual>,
): DatedCashflow[] {
  const merged = [...flows];
  for (const residual of residuals.values()) {
    if (residual.amountMinor !== 0) {
      merged.push({ amountMinor: residual.amountMinor, date: residual.date });
    }
  }
  return merged.sort((left, right) => left.date.localeCompare(right.date));
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
