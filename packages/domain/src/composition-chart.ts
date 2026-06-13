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

/** One base point of the monthly series: a date and whether it is the open period. */
export interface MonthlySeriesEntry {
  /** Calendar day of the chosen snapshot, YYYY-MM-DD. */
  dateKey: string;
  /**
   * True for the current (not-yet-closed) month's latest snapshot, appended so
   * the chart never looks a month stale (ADR 0009); false for finalized closes.
   */
  isOpenPeriod: boolean;
}

/**
 * Selects the monthly base points of the composition chart (ADR 0009): the last
 * snapshot of each calendar month. Past months are finalized closes; the current
 * month's last snapshot (relative to `today`) is flagged as the open period.
 * Ascending by date. Takes the minimal `{ dateKey, monthKey }` shape so any
 * snapshot list satisfies it structurally.
 */
export function selectMonthlySeries(
  snapshots: readonly { dateKey: string; monthKey: string }[],
  today: string,
): MonthlySeriesEntry[] {
  const currentMonthKey = today.slice(0, 7);

  // Last snapshot (by dateKey) wins per month — sort ascending so it overwrites.
  const lastDateByMonth = new Map<string, string>();
  for (const snapshot of [...snapshots].sort((a, b) =>
    a.dateKey.localeCompare(b.dateKey),
  )) {
    lastDateByMonth.set(snapshot.monthKey, snapshot.dateKey);
  }

  return [...lastDateByMonth.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([monthKey, dateKey]) => ({
      dateKey,
      isOpenPeriod: monthKey >= currentMonthKey,
    }));
}

/** One base point of the chart: its date, open/closed flag, and banded figures. */
export interface CompositionSeriesPoint extends CompositionBands {
  dateKey: string;
  isOpenPeriod: boolean;
}

export interface BuildCompositionSeriesInput {
  /** The scope's snapshots — drives monthly base-point selection. */
  snapshots: readonly { dateKey: string; monthKey: string }[];
  /** The scope's frozen holding rows across the window (any dates). */
  rows: readonly DatedSnapshotHoldingRow[];
  /** Ids of the scope's housing holdings (sourced by id, ADR 0013 bridge). */
  housingHoldingIds: readonly string[];
  /** "Today" as YYYY-MM-DD — defines the open (current) month. */
  today: string;
}

/**
 * Assembles the composition chart's series: one banded base point per monthly
 * close (plus the open period), each aggregated from exactly that date's frozen
 * rows. A scope captures at most one snapshot per day (ADR 0005), so `dateKey`
 * keys a snapshot's rows unambiguously within the scope.
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

  return selectMonthlySeries(input.snapshots, input.today)
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

/** A monthly-close vertex on the net-worth line. */
export interface CompositionMarker {
  x: number;
  y: number;
  dateKey: string;
  valueMinor: number;
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
  /** Monthly-close vertices on the net-worth line (the open period is excluded). */
  markers: CompositionMarker[];
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
 * net-worth line is `Σ asset bands − debts`, which equals the snapshot's headline
 * net worth by the reconciliation invariant (ADR 0008).
 */
export function buildCompositionChartGeometry(
  points: CompositionSeriesPoint[],
): CompositionChartGeometry | null {
  if (points.length < 2) return null;

  const xs = timeProportionalXs(
    points.map((p) => p.dateKey),
    COMPOSITION_CHART_WIDTH,
    COMPOSITION_CHART_INSET_X,
  );
  if (!xs) return null;

  const grossSums = points.map((p) =>
    COMPOSITION_ASSET_BANDS.reduce((sum, band) => sum + bandValueMinor(p, band), 0),
  );
  const negDebts = points.map((p) => -p.debtsMinor);
  const { yMin, yMax } = paddedValueDomain([0, ...grossSums, ...negDebts]);
  const toY = (value: number): number =>
    valueToY(value, yMin, yMax, COMPOSITION_CHART_HEIGHT);
  const baselineY = toY(0);

  // Cumulative stacked edges from the zero baseline up; the top edge of the last
  // band (housing) is the gross assets of that period.
  const edges = COMPOSITION_ASSET_BANDS.reduce<number[][]>(
    (acc, band) => [...acc, acc.at(-1)!.map((sum, i) => sum + bandValueMinor(points[i]!, band))],
    [points.map(() => 0)],
  );
  const edgeYs = edges.map((edge) => edge.map(toY));

  const assetBands = COMPOSITION_ASSET_BANDS.map((band, i) => ({
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
    points.map((p) => toY(p.netWorthMinor)),
  );

  const markers = points.flatMap((p, i) =>
    p.isOpenPeriod
      ? []
      : [{ dateKey: p.dateKey, valueMinor: p.netWorthMinor, x: xs[i]!, y: toY(p.netWorthMinor) }],
  );

  return {
    assetBands,
    baselineY,
    debtArea,
    height: COMPOSITION_CHART_HEIGHT,
    markers,
    netWorthLine,
    width: COMPOSITION_CHART_WIDTH,
    yMax,
    yMin,
  };
}
