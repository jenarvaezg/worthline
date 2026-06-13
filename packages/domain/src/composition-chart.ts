/**
 * Net-worth composition chart geometry (#142, ADR 0009) — the dashboard's single
 * historical chart, replacing the separate evolution + decomposition charts.
 *
 * Mirrors the domain equation `gross assets − debts = net worth` directly: gross
 * asset components stack above zero in five bands — the four liquidity-ladder
 * rungs (cash · market · term-locked · illiquid) plus a Vivienda band sourced
 * from the `property` instrument by holding id (the ADR 0013 bridge — the exact
 * carve the drilldown uses, so chart and drill never disagree) — one aggregated
 * debt stack below zero, and a net-worth line over the resulting total. Pure
 * presentation math: no React, no SVG, just numbers and strings.
 */

import type { DatedSnapshotHoldingRow } from "./drilldown";
import {
  EVOLUTION_CHART_HEIGHT,
  EVOLUTION_CHART_INSET_X,
  EVOLUTION_CHART_WIDTH,
  paddedValueDomain,
  timeProportionalXs,
  valueToY,
} from "./evolution-chart";

/** The chart shares the home's SVG viewBox (ADR 0009). */
export const COMPOSITION_CHART_WIDTH = EVOLUTION_CHART_WIDTH;
export const COMPOSITION_CHART_HEIGHT = EVOLUTION_CHART_HEIGHT;
export const COMPOSITION_CHART_INSET_X = EVOLUTION_CHART_INSET_X;

/** The five gross asset bands, in stacking order from the zero baseline up. */
export const COMPOSITION_ASSET_BANDS = [
  "cash",
  "market",
  "term-locked",
  "illiquid",
  "housing",
] as const;

export type CompositionAssetBandId = (typeof COMPOSITION_ASSET_BANDS)[number];

/** The five gross asset bands plus aggregated debts of one period, minor units. */
export interface CompositionBands {
  cashMinor: number;
  marketMinor: number;
  termLockedMinor: number;
  /** Illiquid rung EXCLUDING housing — housing is carved into its own band. */
  illiquidMinor: number;
  /** Holdings whose instrument is `property` (sourced by id, ADR 0013 bridge). */
  housingMinor: number;
  /** All liabilities, aggregated (the single negative stack). */
  debtsMinor: number;
  /** Σ asset bands − debts. Equals the snapshot's headline net worth (ADR 0008). */
  netWorthMinor: number;
}

/**
 * Aggregates one snapshot's frozen holding rows into the composition bands.
 * Housing is sourced by id (`housingHoldingIds`), never by rung: a house sits on
 * `illiquid` but belongs to the Vivienda band, so it is excluded from `illiquid`
 * and never double-counted — the identical carve the drilldown applies.
 */
export function deriveCompositionBands(
  rows: readonly DatedSnapshotHoldingRow[],
  housingHoldingIds: readonly string[],
): CompositionBands {
  const housingIds = new Set(housingHoldingIds);

  let cashMinor = 0;
  let marketMinor = 0;
  let termLockedMinor = 0;
  let illiquidMinor = 0;
  let housingMinor = 0;
  let debtsMinor = 0;

  for (const row of rows) {
    if (row.kind === "liability") {
      debtsMinor += row.valueMinor;
      continue;
    }
    if (housingIds.has(row.holdingId)) {
      housingMinor += row.valueMinor;
      continue;
    }
    switch (row.liquidityTier) {
      case "cash":
        cashMinor += row.valueMinor;
        break;
      case "market":
        marketMinor += row.valueMinor;
        break;
      case "term-locked":
        termLockedMinor += row.valueMinor;
        break;
      case "illiquid":
        illiquidMinor += row.valueMinor;
        break;
      default:
        // Unreachable for asset rows: `buildSnapshotHoldingRows` always freezes a
        // non-null `tierOfAsset(...)` on assets (only liability rows carry a null
        // tier, and those are handled above). A null-tier asset would be an
        // upstream bug; dropping it here would break Σbands == grossAssets.
        break;
    }
  }

  const netWorthMinor =
    cashMinor + marketMinor + termLockedMinor + illiquidMinor + housingMinor - debtsMinor;

  return {
    cashMinor,
    debtsMinor,
    housingMinor,
    illiquidMinor,
    marketMinor,
    netWorthMinor,
    termLockedMinor,
  };
}

/** One base point of the series: a date and whether it is the open period. */
export interface MonthlySeriesEntry {
  /** Calendar day of the chosen snapshot, YYYY-MM-DD. */
  dateKey: string;
  /**
   * True for the current (not-yet-closed) period's latest snapshot, appended so
   * the chart never looks a period stale (ADR 0009); false for finalized closes.
   */
  isOpenPeriod: boolean;
}

/**
 * The selectable temporal ranges of the composition chart (#144). Bounded ranges
 * count back from today; `all` is the full captured history. ADR 0009 keeps these
 * as server-side URL state — never a client pan/zoom gesture.
 */
export const COMPOSITION_RANGES = ["1y", "3y", "5y", "all"] as const;

export type CompositionRange = (typeof COMPOSITION_RANGES)[number];

/** The bucketing density a windowed series is drawn at (#144). */
export type CompositionGranularity = "month" | "quarter" | "year";

/** Months each bounded range spans (counting the current month). */
const RANGE_MONTHS: Record<Exclude<CompositionRange, "all">, number> = {
  "1y": 12,
  "3y": 36,
  "5y": 60,
};

/** A monthKey ("YYYY-MM") as an absolute month ordinal, for pure date math. */
function monthIndex(monthKey: string): number {
  return Number(monthKey.slice(0, 4)) * 12 + (Number(monthKey.slice(5, 7)) - 1);
}

function monthKeyFromIndex(index: number): string {
  const year = Math.floor(index / 12);
  const month = (index % 12) + 1;
  return `${year}-${String(month).padStart(2, "0")}`;
}

/** Whole months from `a` to `b` (b − a), both "YYYY-MM" — the windowed span. */
export function monthsBetween(a: string, b: string): number {
  return monthIndex(b) - monthIndex(a);
}

/**
 * The inclusive earliest monthKey of a range relative to `today` — the window
 * cutoff (#144); `null` for `all` (unbounded). A bounded range of N months ends
 * at today's month and reaches back N−1 months, so it covers exactly N months.
 */
export function rangeStartMonthKey(today: string, range: CompositionRange): string | null {
  if (range === "all") return null;
  return monthKeyFromIndex(monthIndex(today.slice(0, 7)) - (RANGE_MONTHS[range] - 1));
}

/**
 * The bucketing density for a windowed span (#144): monthly for short windows,
 * coarsening to quarterly then annual so a long history stays legible (ADR 0009).
 * Derived from the ACTUAL windowed span, so a sparse multi-year window that holds
 * little data still draws monthly.
 */
export function granularityForSpanMonths(spanMonths: number): CompositionGranularity {
  if (spanMonths <= 36) return "month";
  if (spanMonths <= 84) return "quarter";
  return "year";
}

/**
 * The ranges worth offering for a history of `spanMonths` (#144): a bounded range
 * appears only when the history is longer than its window (otherwise it would
 * show the same as `all`); `all` is always offered. With ~2 years of data this
 * yields just `["1y", "all"]`; under a year, only `["all"]` (hide the control).
 */
export function availableCompositionRanges(spanMonths: number): CompositionRange[] {
  const bounded = (["1y", "3y", "5y"] as const).filter(
    (range) => RANGE_MONTHS[range] < spanMonths,
  );
  return [...bounded, "all"];
}

/** The period a capture day falls in, at the given granularity — lexically ordered. */
function periodKeyOf(dateKey: string, granularity: CompositionGranularity): string {
  const year = dateKey.slice(0, 4);
  if (granularity === "year") return year;
  if (granularity === "quarter") {
    return `${year}-Q${Math.ceil(Number(dateKey.slice(5, 7)) / 3)}`;
  }
  return dateKey.slice(0, 7);
}

/**
 * Selects the base points of the composition chart (ADR 0009) at a given density:
 * the last snapshot of each period (month, quarter, or year). Past periods are
 * finalized closes; the period containing `today` is flagged as the open one.
 * Ascending by date. Takes the minimal `{ dateKey }` shape so any snapshot list
 * satisfies it structurally.
 */
export function selectPeriodicSeries(
  snapshots: readonly { dateKey: string }[],
  today: string,
  granularity: CompositionGranularity,
): MonthlySeriesEntry[] {
  const currentPeriodKey = periodKeyOf(today, granularity);

  // Last snapshot (by dateKey) wins per period — sort ascending so it overwrites.
  const lastDateByPeriod = new Map<string, string>();
  for (const snapshot of [...snapshots].sort((a, b) => a.dateKey.localeCompare(b.dateKey))) {
    lastDateByPeriod.set(periodKeyOf(snapshot.dateKey, granularity), snapshot.dateKey);
  }

  return [...lastDateByPeriod.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([periodKey, dateKey]) => ({
      dateKey,
      isOpenPeriod: periodKey >= currentPeriodKey,
    }));
}

/**
 * Monthly base points — the last snapshot of each calendar month (ADR 0009).
 * A thin wrapper over the general periodic selection at month granularity.
 */
export function selectMonthlySeries(
  snapshots: readonly { dateKey: string; monthKey: string }[],
  today: string,
): MonthlySeriesEntry[] {
  return selectPeriodicSeries(snapshots, today, "month");
}

/** One base point of the chart: its date, open/closed flag, and banded figures. */
export interface CompositionSeriesPoint extends CompositionBands {
  dateKey: string;
  isOpenPeriod: boolean;
}

export interface BuildCompositionSeriesInput {
  /** The scope's snapshots — drives base-point selection. */
  snapshots: readonly { dateKey: string; monthKey: string }[];
  /** The scope's frozen holding rows across the window (any dates). */
  rows: readonly DatedSnapshotHoldingRow[];
  /** Ids of the scope's housing holdings (sourced by id, ADR 0013 bridge). */
  housingHoldingIds: readonly string[];
  /** "Today" as YYYY-MM-DD — defines the open (current) period and the window. */
  today: string;
  /**
   * Temporal range window (#144). Bounded ranges keep only snapshots within the
   * window; density then adapts to the windowed span (month → quarter → year).
   * Defaults to `all` — the full history, unchanged from before this option.
   */
  range?: CompositionRange;
}

/**
 * Assembles the composition chart's series (#142, #144): one banded base point
 * per period close (plus the open period), each aggregated from exactly that
 * date's frozen rows. The `range` windows the history; the bucket density then
 * adapts to the windowed span so a long history stays legible (ADR 0009). A
 * scope captures at most one snapshot per day (ADR 0005), so `dateKey` keys a
 * snapshot's rows unambiguously within the scope.
 */
export function buildCompositionSeries(
  input: BuildCompositionSeriesInput,
): CompositionSeriesPoint[] {
  const rowsByDate = new Map<string, DatedSnapshotHoldingRow[]>();
  for (const row of input.rows) {
    const bucket = rowsByDate.get(row.dateKey);
    if (bucket) {
      bucket.push(row);
    } else {
      rowsByDate.set(row.dateKey, [row]);
    }
  }

  // Window to the selected range, then pick the density from the windowed span.
  const cutoff = rangeStartMonthKey(input.today, input.range ?? "all");
  const windowed = cutoff
    ? input.snapshots.filter((snapshot) => snapshot.monthKey >= cutoff)
    : input.snapshots;
  let minIdx = Infinity;
  let maxIdx = -Infinity;
  for (const snapshot of windowed) {
    const idx = monthIndex(snapshot.monthKey);
    if (idx < minIdx) minIdx = idx;
    if (idx > maxIdx) maxIdx = idx;
  }
  const spanMonths = windowed.length > 0 ? maxIdx - minIdx : 0;
  const granularity = granularityForSpanMonths(spanMonths);

  return selectPeriodicSeries(windowed, input.today, granularity)
    // Skip legacy snapshots that predate holding rows (ADR 0008): with no rows
    // they would plot a false zero. Every plotted point is row-backed, so its
    // bands reconcile to the snapshot's headline net worth.
    .filter((entry) => rowsByDate.has(entry.dateKey))
    .map((entry) => ({
      ...deriveCompositionBands(rowsByDate.get(entry.dateKey)!, input.housingHoldingIds),
      dateKey: entry.dateKey,
      isOpenPeriod: entry.isOpenPeriod,
    }));
}

/** A hover anchor: a point in viewBox space carrying the value it represents. */
export interface CompositionHoverPoint {
  x: number;
  y: number;
  valueMinor: number;
}

/** A hover anchor for one asset band at one period. */
export interface CompositionBandHoverPoint extends CompositionHoverPoint {
  band: CompositionAssetBandId;
}

/**
 * Per-period hover anchors for every component of the chart (#143): one anchor
 * per asset band, the aggregated debt, and the net-worth point — so the web
 * layer can place a native <title> on each without re-deriving geometry.
 */
export interface CompositionPeriodGeometry {
  dateKey: string;
  isOpenPeriod: boolean;
  /** One anchor per asset band (slab midpoint), in stacking order. */
  assetBands: CompositionBandHoverPoint[];
  /** Debt anchor (slab midpoint), or null when this period carries no debt. */
  debt: CompositionHoverPoint | null;
  /** Net-worth anchor, on the line. */
  netWorth: CompositionHoverPoint;
}

export interface CompositionBandGeometry {
  band: CompositionAssetBandId;
  /** Closed polygon between the band's lower and upper stacked edges. */
  areaPoints: string;
}

export interface CompositionChartGeometry {
  width: number;
  height: number;
  /** The y of the zero baseline — gross assets stack above it, debts below. */
  baselineY: number;
  /** The five gross asset bands, baseline-up stacking order. */
  assetBands: CompositionBandGeometry[];
  /**
   * Closed polygon of the aggregated debt stack (baseline down to −debts), or
   * `null` when no period carries debt.
   */
  debtArea: string | null;
  /** The net-worth polyline ("x,y x,y …"). */
  netWorthLine: string;
  /** Per-period hover anchors for every component (asset bands, debt, net worth). */
  periods: CompositionPeriodGeometry[];
  /** Padded value domain (minor units) the y scale maps from; spans the baseline. */
  yMin: number;
  yMax: number;
}

function bandValueMinor(point: CompositionBands, band: CompositionAssetBandId): number {
  switch (band) {
    case "cash":
      return point.cashMinor;
    case "market":
      return point.marketMinor;
    case "term-locked":
      return point.termLockedMinor;
    case "illiquid":
      return point.illiquidMinor;
    case "housing":
      return point.housingMinor;
  }
}

function toPointsString(xs: number[], ys: number[]): string {
  return xs.map((x, i) => `${x},${ys[i]}`).join(" ");
}

/** Closed polygon: upper edge left→right, then lower edge right→left. */
function toAreaString(xs: number[], upperYs: number[], lowerYs: number[]): string {
  const upper = xs.map((x, i) => `${x},${upperYs[i]}`);
  const lower = xs.map((x, i) => `${x},${lowerYs[i]}`).reverse();
  return [...upper, ...lower].join(" ");
}

/**
 * Builds the composition chart geometry, or `null` when there is no chart to
 * draw — the shared rule: fewer than two points (the placeholder threshold) or a
 * degenerate zero-length time span.
 *
 * One shared y domain spans the whole picture: the zero baseline, the tallest
 * gross-asset stack above it, and the deepest aggregated debt below it. Gross
 * asset values and debt balances are non-negative, so no band ever crosses zero
 * — there is no lines-fallback (unlike the old decomposition chart). The
 * net-worth line is `Σ shown asset bands − debts`. With no exclusions that equals
 * the snapshot's headline net worth by the reconciliation invariant (ADR 0008);
 * `excludedBands` drops a band from the stack, the net line and the y domain
 * (so the chart rescales to the remaining bands — e.g. hiding a dominant
 * Vivienda) and omits it from the per-period hover anchors.
 */
export interface CompositionGeometryOptions {
  /** Asset bands to drop from the stack, net line, domain and hover anchors. */
  excludedBands?: readonly CompositionAssetBandId[];
}

export function buildCompositionChartGeometry(
  points: CompositionSeriesPoint[],
  options: CompositionGeometryOptions = {},
): CompositionChartGeometry | null {
  if (points.length < 2) return null;

  const xs = timeProportionalXs(
    points.map((p) => p.dateKey),
    COMPOSITION_CHART_WIDTH,
    COMPOSITION_CHART_INSET_X,
  );
  if (!xs) return null;

  const excluded = new Set(options.excludedBands ?? []);
  const shownBands = COMPOSITION_ASSET_BANDS.filter((band) => !excluded.has(band));

  // Gross of the SHOWN bands, and net worth of what is shown (gross − debts).
  // With nothing excluded these equal grossAssets and the headline net worth.
  const grossSums = points.map((p) =>
    shownBands.reduce((sum, band) => sum + bandValueMinor(p, band), 0),
  );
  const nets = points.map((p, i) => grossSums[i]! - p.debtsMinor);
  const negDebts = points.map((p) => -p.debtsMinor);
  const { yMin, yMax } = paddedValueDomain([0, ...grossSums, ...negDebts]);
  const toY = (value: number): number =>
    valueToY(value, yMin, yMax, COMPOSITION_CHART_HEIGHT);
  const baselineY = toY(0);

  // Cumulative stacked edges from the zero baseline up over the shown bands; the
  // top edge of the last band is the shown gross assets of that period.
  const edges = shownBands.reduce<number[][]>(
    (acc, band) => [...acc, acc.at(-1)!.map((sum, i) => sum + bandValueMinor(points[i]!, band))],
    [points.map(() => 0)],
  );
  const edgeYs = edges.map((edge) => edge.map(toY));

  const assetBands = shownBands.map((band, i) => ({
    areaPoints: toAreaString(xs, edgeYs[i + 1]!, edgeYs[i]!),
    band,
  }));

  const hasDebt = points.some((p) => p.debtsMinor > 0);
  const debtArea = hasDebt
    ? toAreaString(
        xs,
        points.map(() => baselineY),
        points.map((p) => toY(-p.debtsMinor)),
      )
    : null;

  const netWorthLine = toPointsString(
    xs,
    nets.map(toY),
  );

  // Hover anchors per period: each shown asset band at its slab midpoint, the
  // debt slab midpoint, and the net-worth point on the line.
  const periods = points.map<CompositionPeriodGeometry>((p, i) => {
    const x = xs[i]!;
    return {
      assetBands: shownBands.map((band, b) => ({
        band,
        valueMinor: bandValueMinor(p, band),
        x,
        y: (edgeYs[b]![i]! + edgeYs[b + 1]![i]!) / 2,
      })),
      dateKey: p.dateKey,
      debt:
        p.debtsMinor > 0
          ? { valueMinor: p.debtsMinor, x, y: (baselineY + toY(-p.debtsMinor)) / 2 }
          : null,
      isOpenPeriod: p.isOpenPeriod,
      netWorth: { valueMinor: nets[i]!, x, y: toY(nets[i]!) },
    };
  });

  return {
    assetBands,
    baselineY,
    debtArea,
    height: COMPOSITION_CHART_HEIGHT,
    netWorthLine,
    periods,
    width: COMPOSITION_CHART_WIDTH,
    yMax,
    yMin,
  };
}
