/**
 * Home hero "Origen del cambio" view-model (#661, PRD #653 S3).
 *
 * The hero sheet gets two figures straight from the S1 delta engine — the SAME
 * `buildMonthlyCloseBreakdownSeries` / `computeDeltaBreakdownWindow` that feed
 * /historico, so the home never re-derives the split:
 *
 *  - `monthly`: the latest confirmed monthly-close window (the micro-band under
 *    the delta chips) — market / payouts / net savings.
 *  - `weekly`: the "Esta semana" block — the same three-band split over the
 *    ~7-day window ending at the latest snapshot (daily snapshots, ADR 0037).
 *
 * This module owns only the numeric shaping (band ordering, magnitude weights,
 * signs); `formatHeroBreakdown` turns it into privacy-aware strings for render,
 * mirroring the movers view-model split.
 */

import {
  buildMonthlyCloseBreakdownSeries,
  computeDeltaBreakdownWindow,
  type DatedAmount,
  type DeltaBreakdownBandId,
  type DeltaBreakdownBands,
  formatMoneyMinorPrivacy,
  type InvestmentOperation,
  type NetWorthSnapshot,
  type OwnershipShare,
  type SnapshotHoldingRow,
  type ValuationMethod,
} from "@worthline/domain";

export type HeroBandSign = "pos" | "neg" | "zero";

/** The window a weekly block spans: at least this many days back for a base. */
const WEEKLY_WINDOW_DAYS = 7;

export interface HeroBreakdownBand {
  id: DeltaBreakdownBandId;
  amountMinor: number;
  sign: HeroBandSign;
  /** Magnitude share of the change [0..1], for the mini-band segment width. */
  weight: number;
}

export interface HeroMonthlyBreakdown {
  /** The later close's month (YYYY-MM) — labelled at format time. */
  monthKey: string;
  aggregateDeltaMinor: number;
  aggregateSign: HeroBandSign;
  /** market, then payouts (only when non-zero), then netSavings. */
  bands: HeroBreakdownBand[];
  showsPayouts: boolean;
}

export interface HeroWeeklyBreakdown {
  /** Base snapshot day (exclusive lower bound), YYYY-MM-DD. */
  windowStartDateKey: string;
  /** Latest snapshot day (inclusive upper bound), YYYY-MM-DD. */
  windowEndDateKey: string;
  aggregateDeltaMinor: number;
  aggregateSign: HeroBandSign;
  bands: HeroBreakdownBand[];
}

export interface HeroBreakdownData {
  /** Null when there are fewer than two confirmed closes with frozen rows. */
  monthly: HeroMonthlyBreakdown | null;
  /** Null when there is no snapshot at least a week before the latest. */
  weekly: HeroWeeklyBreakdown | null;
}

export interface BuildHeroBreakdownInput {
  snapshots: readonly NetWorthSnapshot[];
  holdingRowsBySnapshotId: ReadonlyMap<string, readonly SnapshotHoldingRow[]>;
  valuationMethodByHoldingId: ReadonlyMap<string, ValuationMethod>;
  operationsByHoldingId: ReadonlyMap<string, readonly InvestmentOperation[]>;
  payoutsByHolding: ReadonlyMap<string, readonly DatedAmount[]>;
  ownershipByHoldingId: ReadonlyMap<string, readonly OwnershipShare[]>;
  scopeMemberIds: ReadonlySet<string>;
  today: string;
}

function signOf(amountMinor: number): HeroBandSign {
  if (amountMinor > 0) return "pos";
  if (amountMinor < 0) return "neg";
  return "zero";
}

function shiftDaysUTC(dateKey: string, days: number): string {
  const [y, m, d] = dateKey.split("-").map(Number);
  const shifted = new Date(Date.UTC(y!, m! - 1, d! + days));
  return shifted.toISOString().slice(0, 10);
}

/**
 * Order the three bands (market · payouts-when-present · netSavings) and weight
 * each by its magnitude share, so a thin stacked band reads as "of what moved,
 * this much was market / cobros / ahorro". Signs live on each band, not the bar.
 */
function toHeroBands(bands: DeltaBreakdownBands): HeroBreakdownBand[] {
  const ordered: Array<{ id: DeltaBreakdownBandId; amountMinor: number }> = [
    { amountMinor: bands.marketMinor, id: "market" },
  ];
  if (bands.payoutsMinor !== 0) {
    ordered.push({ amountMinor: bands.payoutsMinor, id: "payouts" });
  }
  ordered.push({ amountMinor: bands.netSavingsMinor, id: "netSavings" });

  const magnitudeTotal = ordered.reduce(
    (sum, band) => sum + Math.abs(band.amountMinor),
    0,
  );

  return ordered.map((band) => ({
    amountMinor: band.amountMinor,
    id: band.id,
    sign: signOf(band.amountMinor),
    weight: magnitudeTotal === 0 ? 0 : Math.abs(band.amountMinor) / magnitudeTotal,
  }));
}

function buildMonthly(input: BuildHeroBreakdownInput): HeroMonthlyBreakdown | null {
  const periods = buildMonthlyCloseBreakdownSeries({
    holdingRowsBySnapshotId: input.holdingRowsBySnapshotId,
    operationsByHoldingId: input.operationsByHoldingId,
    ownershipByHoldingId: input.ownershipByHoldingId,
    payoutsByHolding: input.payoutsByHolding,
    scopeMemberIds: input.scopeMemberIds,
    snapshots: input.snapshots,
    today: input.today,
    valuationMethodByHoldingId: input.valuationMethodByHoldingId,
  });

  // The micro-band explains the newest confirmed close only. If that period is a
  // gap (its frozen rows fell outside the dashboard's read window), hide it rather
  // than mislabel an older month as "del mes".
  const latest = periods.at(-1);
  if (!latest || latest.bands === null) {
    return null;
  }

  return {
    aggregateDeltaMinor: latest.aggregateDeltaMinor,
    aggregateSign: signOf(latest.aggregateDeltaMinor),
    bands: toHeroBands(latest.bands),
    monthKey: latest.monthKey,
    showsPayouts: latest.bands.payoutsMinor !== 0,
  };
}

function buildWeekly(input: BuildHeroBreakdownInput): HeroWeeklyBreakdown | null {
  const ordered = [...input.snapshots].sort((left, right) =>
    left.dateKey.localeCompare(right.dateKey),
  );
  const latest = ordered.at(-1);
  if (!latest || ordered.length < 2) {
    return null;
  }

  // Base = the newest snapshot at least a week before the latest. Absent one, the
  // history is younger than a week — no honest weekly window yet.
  const target = shiftDaysUTC(latest.dateKey, -WEEKLY_WINDOW_DAYS);
  // `target` is a week before `latest`, so `<= target` already implies `< latest`.
  const base = [...ordered].reverse().find((snapshot) => snapshot.dateKey <= target);
  if (!base) {
    return null;
  }

  const previousRows = input.holdingRowsBySnapshotId.get(base.id);
  const currentRows = input.holdingRowsBySnapshotId.get(latest.id);
  if (!previousRows || !currentRows) {
    return null;
  }

  const aggregateDeltaMinor =
    latest.totalNetWorth.amountMinor - base.totalNetWorth.amountMinor;

  const bands = computeDeltaBreakdownWindow({
    aggregateDeltaMinor,
    currentRows,
    operationsByHoldingId: input.operationsByHoldingId,
    ownershipByHoldingId: input.ownershipByHoldingId,
    payoutsByHolding: input.payoutsByHolding,
    previousRows,
    scopeMemberIds: input.scopeMemberIds,
    valuationMethodByHoldingId: input.valuationMethodByHoldingId,
    windowEndInclusive: latest.dateKey,
    windowStartExclusive: base.dateKey,
  });

  return {
    aggregateDeltaMinor,
    aggregateSign: signOf(aggregateDeltaMinor),
    bands: toHeroBands(bands),
    windowEndDateKey: latest.dateKey,
    windowStartDateKey: base.dateKey,
  };
}

export function buildHeroBreakdownData(
  input: BuildHeroBreakdownInput,
): HeroBreakdownData {
  return {
    monthly: buildMonthly(input),
    weekly: buildWeekly(input),
  };
}

// ── formatting (privacy-aware) ───────────────────────────────────────────────

const BAND_LABELS: Record<DeltaBreakdownBandId, string> = {
  market: "Mercado",
  netSavings: "Ahorro",
  payouts: "Cobros",
};

export interface FormattedHeroBand {
  id: DeltaBreakdownBandId;
  label: string;
  amountFmt: string;
  sign: HeroBandSign;
  /** Whole-percent width for the mini-band segment. */
  weightPct: number;
}

export interface FormattedHeroMonthly {
  monthLabel: string;
  aggregateFmt: string;
  aggregateSign: HeroBandSign;
  bands: FormattedHeroBand[];
  showsPayouts: boolean;
}

export interface FormattedHeroWeekly {
  rangeLabel: string;
  aggregateFmt: string;
  aggregateSign: HeroBandSign;
  bands: FormattedHeroBand[];
}

export interface FormattedHeroBreakdown {
  monthly: FormattedHeroMonthly | null;
  weekly: FormattedHeroWeekly | null;
}

function signedMoney(
  amountMinor: number,
  currency: string,
  privacyMode: boolean,
): string {
  const amount = formatMoneyMinorPrivacy({ amountMinor, currency }, privacyMode);
  return amountMinor > 0 ? `+${amount}` : amount;
}

function monthLabelOf(monthKey: string): string {
  const [y, m] = monthKey.split("-").map(Number);
  return new Intl.DateTimeFormat("es-ES", {
    month: "long",
    timeZone: "UTC",
    year: "numeric",
  }).format(new Date(Date.UTC(y!, m! - 1, 1)));
}

function dayLabelOf(dateKey: string): string {
  const [y, m, d] = dateKey.split("-").map(Number);
  return new Intl.DateTimeFormat("es-ES", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(y!, m! - 1, d!)));
}

function formatBands(
  bands: readonly HeroBreakdownBand[],
  currency: string,
  privacyMode: boolean,
): FormattedHeroBand[] {
  return bands.map((band) => ({
    amountFmt: signedMoney(band.amountMinor, currency, privacyMode),
    id: band.id,
    label: BAND_LABELS[band.id],
    sign: band.sign,
    weightPct: Math.round(band.weight * 100),
  }));
}

export function formatHeroBreakdown(
  data: HeroBreakdownData,
  currency: string,
  privacyMode: boolean,
): FormattedHeroBreakdown {
  return {
    monthly: data.monthly
      ? {
          aggregateFmt: signedMoney(
            data.monthly.aggregateDeltaMinor,
            currency,
            privacyMode,
          ),
          aggregateSign: data.monthly.aggregateSign,
          bands: formatBands(data.monthly.bands, currency, privacyMode),
          monthLabel: monthLabelOf(data.monthly.monthKey),
          showsPayouts: data.monthly.showsPayouts,
        }
      : null,
    weekly: data.weekly
      ? {
          aggregateFmt: signedMoney(
            data.weekly.aggregateDeltaMinor,
            currency,
            privacyMode,
          ),
          aggregateSign: data.weekly.aggregateSign,
          bands: formatBands(data.weekly.bands, currency, privacyMode),
          rangeLabel: `desde ${dayLabelOf(data.weekly.windowStartDateKey)}`,
        }
      : null,
  };
}
