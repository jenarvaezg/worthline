/**
 * Net-worth composition chart geometry (#142, ADR 0009) — the dashboard's single
 * historical chart, replacing the separate evolution + decomposition charts.
 *
 * Mirrors the domain equation `gross assets − debts = net worth` directly: gross
 * asset components stack above zero in five bands — the five liquidity-ladder
 * rungs (cash · market · term-locked · illiquid · housing), where housing is now a
 * real rung (ADR 0022), so chart, donut and drill classify the home identically —
 * one aggregated debt stack below zero, and a net-worth line over the resulting
 * total. Pure presentation math: no React, no SVG, just numbers and strings.
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
  /** Illiquid rung — housing now sits on its own `housing` rung, never here. */
  illiquidMinor: number;
  /** The housing rung — every property instrument (ADR 0022). */
  housingMinor: number;
  /** All liabilities, aggregated (the single negative stack). */
  debtsMinor: number;
  /**
   * The portion of `debtsMinor` that secures a housing asset — every liability
   * frozen with `securesHousing === true` (#180), keyed off that flag and NOT
   * the instrument (ADR 0013: a snapshot row freezes no instrument, only
   * `securesHousing`). A breakdown of `debtsMinor`, never a replacement: it is
   * additive (`debtsMinor` still sums EVERY liability), so the reconciliation
   * identity holds (ADR 0008). Mirrors the housing asset carve so hiding Vivienda
   * can shed the debt that secures it from the negative stack (#213).
   */
  debtsSecuredByHousingMinor: number;
  /** Σ asset bands − debts. Equals the snapshot's headline net worth (ADR 0008). */
  netWorthMinor: number;
}

/**
 * Aggregates one snapshot's frozen holding rows into the composition bands.
 * Housing is the dedicated `housing` rung (ADR 0022): a post-recut house freezes
 * with `liquidityTier === "housing"` and buckets straight into the Vivienda band.
 * Pre-migration historical rows can still carry a legacy `illiquid` tier with
 * `countsAsHousing` true — the DEFENSIVE fallback `countsAsHousing ? "housing" :
 * liquidityTier` routes those to the Vivienda band too, so a legacy house is never
 * double-counted into `illiquid`.
 */
export function deriveCompositionBands(
  rows: readonly DatedSnapshotHoldingRow[],
): CompositionBands {
  let cashMinor = 0;
  let marketMinor = 0;
  let termLockedMinor = 0;
  let illiquidMinor = 0;
  let housingMinor = 0;
  let debtsMinor = 0;
  let debtsSecuredByHousingMinor = 0;

  for (const row of rows) {
    if (row.kind === "liability") {
      // Every liability lands in the aggregate (ADR 0008 reconciliation), and a
      // housing-securing one is ALSO tallied into the carve — a breakdown, not a
      // partition. Keyed off the frozen `securesHousing` flag, never the
      // instrument (ADR 0013).
      debtsMinor += row.valueMinor;
      if (row.securesHousing) {
        debtsSecuredByHousingMinor += row.valueMinor;
      }
      continue;
    }
    // The row's effective rung: its frozen tier, but a legacy house (frozen
    // illiquid before the v28 recut) still buckets to housing via countsAsHousing.
    const rung = row.countsAsHousing ? "housing" : row.liquidityTier;
    switch (rung) {
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
      case "housing":
        housingMinor += row.valueMinor;
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
    debtsSecuredByHousingMinor,
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
export function rangeStartMonthKey(
  today: string,
  range: CompositionRange,
): string | null {
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
  for (const snapshot of [...snapshots].sort((a, b) =>
    a.dateKey.localeCompare(b.dateKey),
  )) {
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

  return (
    selectPeriodicSeries(windowed, input.today, granularity)
      // Skip legacy snapshots that predate holding rows (ADR 0008): with no rows
      // they would plot a false zero. Every plotted point is row-backed, so its
      // bands reconcile to the snapshot's headline net worth.
      .filter((entry) => rowsByDate.has(entry.dateKey))
      .map((entry) => ({
        ...deriveCompositionBands(rowsByDate.get(entry.dateKey)!),
        dateKey: entry.dateKey,
        isOpenPeriod: entry.isOpenPeriod,
      }))
  );
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

/** One stacked bar rectangle of a band at one period, in viewBox space. */
export interface CompositionBarRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CompositionBandGeometry {
  band: CompositionAssetBandId;
  /**
   * One rectangle per period — the band's stacked slab as a monthly bar, from
   * its lower stacked edge up to its upper edge. Empty-valued periods emit a
   * zero-height rect so the array stays index-aligned with `periods`.
   */
  bars: CompositionBarRect[];
}

export interface CompositionChartGeometry {
  width: number;
  height: number;
  /** The y of the zero baseline — gross assets stack above it, debts below. */
  baselineY: number;
  /** The five gross asset bands, baseline-up stacking order. */
  assetBands: CompositionBandGeometry[];
  /**
   * Per-period rectangles of the aggregated debt stack (baseline down to
   * −debts), or `null` when no period carries debt.
   */
  debtBars: CompositionBarRect[] | null;
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

/** Fraction of a period's slot a bar fills — the rest is the inter-bar gutter. */
const BAR_WIDTH_RATIO = 0.6;

/**
 * The bar width shared by every period: `BAR_WIDTH_RATIO` of the smallest gap
 * between adjacent x-centres (so the densest pair never overlaps). With a single
 * gap (two periods) the slot is just that gap; a sensible floor keeps a bar
 * visible even when periods crowd at one edge.
 */
function barWidthFor(xs: number[]): number {
  let minGap = Infinity;
  for (let i = 1; i < xs.length; i += 1) {
    const gap = xs[i]! - xs[i - 1]!;
    if (gap > 0 && gap < minGap) minGap = gap;
  }
  if (!Number.isFinite(minGap)) minGap = COMPOSITION_CHART_WIDTH;
  return Math.max(2, minGap * BAR_WIDTH_RATIO);
}

/**
 * One stacked rectangle from `upperY` (top, smaller y) to `lowerY` (bottom),
 * centred on `x`. Always non-negative height; a zero-value slab yields height 0.
 */
function toBarRect(
  x: number,
  width: number,
  upperY: number,
  lowerY: number,
): CompositionBarRect {
  return {
    height: Math.max(0, lowerY - upperY),
    width,
    x: x - width / 2,
    y: Math.min(upperY, lowerY),
  };
}

/**
 * How the housing rung and its securing mortgage are presented — the primary
 * control over the Vivienda band (this design pass). The reconciliation
 * invariant (ADR 0008) holds across all three: the net-worth LINE is identical
 * for `"gross"` and `"net"`, because folding the securing mortgage into the
 * equity band is purely a presentation rearrangement (algebraically
 * `housing − secured` above the baseline and `debts − secured` below sum to the
 * same `housing − debts`).
 *
 * - `"gross"`: housing band = `housingMinor`; the full `debtsMinor` stacks below.
 * - `"net"` (default): housing band = `max(0, housingMinor − secured)` (equity),
 *   and the securing mortgage is folded out of the negative stack
 *   (`debtsMinor − secured`) so it is never drawn twice.
 * - `"hidden"`: the housing band is dropped AND its securing debt shed — exactly
 *   the old `excludedBands: ["housing"]` behaviour (#213); the net line becomes
 *   the non-housing net.
 */
export type CompositionHousingMode = "gross" | "net" | "hidden";

/**
 * Builds the composition chart geometry, or `null` when there is no chart to
 * draw — the shared rule: fewer than two points (the placeholder threshold) or a
 * degenerate zero-length time span.
 *
 * One shared y domain spans the whole picture: the zero baseline, the tallest
 * gross-asset stack above it, and the deepest aggregated debt below it. Gross
 * asset values and debt balances are non-negative, so no band ever crosses zero.
 * Each band draws as one monthly bar RECTANGLE per period stacked from the
 * baseline up; debts draw as per-period rectangles below it. The net-worth line
 * is `Σ shown asset bands − shown debts`.
 *
 * `housingMode` is the primary Vivienda control (see {@link CompositionHousingMode}):
 * `"net"` (default) folds the securing mortgage into a Vivienda EQUITY band,
 * `"gross"` shows the home and full debt separately, `"hidden"` drops both.
 * `excludedBands` is still honoured (a low-level drop of bands from the stack,
 * net line, y domain and hover anchors); excluding `housing` is equivalent to
 * `housingMode: "hidden"`. The two compose — whichever drops `housing` wins.
 */
export interface CompositionGeometryOptions {
  /** Asset bands to drop from the stack, net line, domain and hover anchors. */
  excludedBands?: readonly CompositionAssetBandId[];
  /** How the Vivienda band + its mortgage are presented (default `"net"`). */
  housingMode?: CompositionHousingMode;
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

  const housingMode = options.housingMode ?? "net";
  const excluded = new Set(options.excludedBands ?? []);
  // `"hidden"` drops the Vivienda band exactly like the legacy exclusion; either
  // route hides it (whichever sets it wins).
  const housingHidden = housingMode === "hidden" || excluded.has("housing");
  if (housingHidden) excluded.add("housing");
  const shownBands = COMPOSITION_ASSET_BANDS.filter((band) => !excluded.has(band));
  const barWidth = barWidthFor(xs);

  // Whether the home's securing mortgage is folded out of the negative stack —
  // true in BOTH `"net"` (folded into the equity band) and when housing is hidden
  // (shed entirely, #213). Only `"gross"` keeps the full debt below the baseline.
  const foldHousingDebt = !housingHidden && housingMode === "net";
  const dropHousingDebt = housingHidden || foldHousingDebt;

  // Hiding Vivienda sheds the debt that SECURES it from the negative stack too,
  // mirroring the asset-side carve (#213); `"net"` folds that same securing slice
  // into the equity band instead. The shed/folded debt is the frozen
  // `securesHousing` portion (ADR 0013), so the chart still reads
  // `Σ shown assets − Σ shown debts`. In `"gross"` nothing is dropped.
  const shownDebt = (p: CompositionSeriesPoint): number =>
    dropHousingDebt ? p.debtsMinor - p.debtsSecuredByHousingMinor : p.debtsMinor;

  // The drawn value of an asset band at a period: housing becomes net equity in
  // `"net"` (clamped at zero for an underwater home so the bar never inverts),
  // every other band is its raw value.
  const bandDrawnMinor = (
    p: CompositionSeriesPoint,
    band: CompositionAssetBandId,
  ): number =>
    band === "housing" && foldHousingDebt
      ? Math.max(0, p.housingMinor - p.debtsSecuredByHousingMinor)
      : bandValueMinor(p, band);

  // Net worth of what is shown (gross − shown debts). Computed from the RAW band
  // values (not the clamped equity) so the reconciliation invariant (ADR 0008)
  // holds exactly: `"net"` and `"gross"` yield the identical net line — folding
  // the mortgage is a pure rearrangement. With everything shown this equals the
  // snapshot's headline net worth.
  const shownDebtsFull = points.map((p) =>
    housingHidden ? p.debtsMinor - p.debtsSecuredByHousingMinor : p.debtsMinor,
  );
  const grossRawSums = points.map((p) =>
    shownBands.reduce((sum, band) => sum + bandValueMinor(p, band), 0),
  );
  const nets = points.map((p, i) => grossRawSums[i]! - shownDebtsFull[i]!);

  // Stacked geometry uses the DRAWN band values (equity for housing in `"net"`),
  // and the drawn debts (the folded/shed remainder) below the baseline.
  const grossDrawnSums = points.map((p) =>
    shownBands.reduce((sum, band) => sum + bandDrawnMinor(p, band), 0),
  );
  const shownDebts = points.map(shownDebt);
  const negDebts = shownDebts.map((debt) => -debt);
  const { yMin, yMax } = paddedValueDomain([0, ...grossDrawnSums, ...negDebts]);
  const toY = (value: number): number =>
    valueToY(value, yMin, yMax, COMPOSITION_CHART_HEIGHT);
  const baselineY = toY(0);

  // Cumulative stacked edges from the zero baseline up over the shown bands; the
  // top edge of the last band is the shown (drawn) gross assets of that period.
  const edges = shownBands.reduce<number[][]>(
    (acc, band) => [
      ...acc,
      acc.at(-1)!.map((sum, i) => sum + bandDrawnMinor(points[i]!, band)),
    ],
    [points.map(() => 0)],
  );
  const edgeYs = edges.map((edge) => edge.map(toY));

  const assetBands = shownBands.map((band, i) => ({
    band,
    bars: xs.map((x, p) => toBarRect(x, barWidth, edgeYs[i + 1]![p]!, edgeYs[i]![p]!)),
  }));

  const hasDebt = shownDebts.some((debt) => debt > 0);
  const debtBars = hasDebt
    ? xs.map((x, p) => toBarRect(x, barWidth, baselineY, toY(-shownDebts[p]!)))
    : null;

  const netWorthLine = toPointsString(xs, nets.map(toY));

  // Hover anchors per period: each shown asset band at its bar-rect midpoint, the
  // debt bar-rect midpoint, and the net-worth point on the line. Band anchors
  // carry the DRAWN value (housing equity in `"net"`) so the tooltip matches the
  // bar; the net-worth anchor carries the reconciled net.
  const periods = points.map<CompositionPeriodGeometry>((p, i) => {
    const x = xs[i]!;
    return {
      assetBands: shownBands.map((band, b) => ({
        band,
        valueMinor: bandDrawnMinor(p, band),
        x,
        y: (edgeYs[b]![i]! + edgeYs[b + 1]![i]!) / 2,
      })),
      dateKey: p.dateKey,
      debt:
        shownDebts[i]! > 0
          ? {
              valueMinor: shownDebts[i]!,
              x,
              y: (baselineY + toY(-shownDebts[i]!)) / 2,
            }
          : null,
      isOpenPeriod: p.isOpenPeriod,
      netWorth: { valueMinor: nets[i]!, x, y: toY(nets[i]!) },
    };
  });

  return {
    assetBands,
    baselineY,
    debtBars,
    height: COMPOSITION_CHART_HEIGHT,
    netWorthLine,
    periods,
    width: COMPOSITION_CHART_WIDTH,
    yMax,
    yMin,
  };
}
