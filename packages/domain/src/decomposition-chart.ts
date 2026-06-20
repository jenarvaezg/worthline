/**
 * Generic stacked-chart geometry — pure presentation math for server-rendered
 * stacked SVGs (ADR 0009). Named series in stacking order over a shared date
 * series: stacked per-period BARS (plus the closed polygon `areaPoints` and the
 * stack-total line) when every series stays ≥ 0 across the window, an honest
 * fall back to plain lines otherwise. The bar geometry mirrors the main
 * composition chart (#142) so the drilldown aggregate reads in the same visual
 * language. Shared by the drilldown per-tier stack (#76/#77); the home's
 * net-worth composition chart (#142) has its own bidirectional geometry. No
 * React, no SVG — just numbers and strings.
 *
 * (The file keeps the `decomposition-chart` name for history: the standalone
 * decomposition chart was folded into the composition chart in #142, leaving
 * this generic engine in place.)
 */

import {
  categoricalSlotXs,
  EVOLUTION_CHART_HEIGHT,
  EVOLUTION_CHART_INSET_X,
  EVOLUTION_CHART_WIDTH,
  paddedValueDomain,
  timeProportionalXs,
  valueToY,
} from "./evolution-chart";

/** One named value series of a stacked chart, in stacking order. */
export interface StackedSeriesInput<Id extends string> {
  band: Id;
  /** One value per date key, aligned by index. */
  values: number[];
}

/** One stacked bar rectangle of a band at one period, in viewBox space. */
export interface StackedBarRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface StackedBandGeometry<Id extends string> {
  band: Id;
  /**
   * Stacked mode: closed polygon between the band's lower and upper stack
   * edges (upper edge left→right, then lower edge right→left). `null` in
   * lines mode.
   */
  areaPoints: string | null;
  /**
   * Stacked mode: one rectangle per period — the band's stacked slab as a
   * per-period BAR, mirroring the main composition chart's bar geometry
   * (#142). `null` in lines mode. Empty-valued periods emit a zero-height
   * rect so the array stays index-aligned with the date series.
   */
  bars: StackedBarRect[] | null;
  /**
   * Stacked mode: the band's upper stack edge. Lines mode: the band's own
   * series polyline.
   */
  linePoints: string;
}

export interface StackedChartGeometry<Id extends string> {
  mode: "stacked" | "lines";
  width: number;
  height: number;
  /** Bands in stacking order from the baseline up. */
  bands: Array<StackedBandGeometry<Id>>;
  /**
   * Stacked mode: the polyline over the stack total (the top edge of the last
   * band) so a net/total line can ride over the bars; `null` in lines mode.
   */
  totalLine: string | null;
  /** Value domain (minor units) the y scale maps from. */
  yMin: number;
  yMax: number;
}

function toPointsString(xs: number[], ys: number[]): string {
  return xs.map((x, i) => `${x},${ys[i]}`).join(" ");
}

/** Fraction of a period's slot a bar fills — the rest is the inter-bar gutter. */
const BAR_WIDTH_RATIO = 0.85;

/**
 * The bar width shared by every period: `BAR_WIDTH_RATIO` of the even
 * categorical slot. The stacked-bar path draws on uniform column slots (not a
 * time axis), so the width is just `slotW * ratio` — no gap-scanning, no median
 * — and every column is uniform and near-touching. Mirrors the main composition
 * chart's `barWidthFor` (#142). A small floor keeps a narrow bar visible.
 */
function barWidthFor(slotW: number): number {
  return Math.max(2, slotW * BAR_WIDTH_RATIO);
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
): StackedBarRect {
  return {
    height: Math.max(0, lowerY - upperY),
    width,
    x: x - width / 2,
    y: Math.min(upperY, lowerY),
  };
}

/** Closed polygon: upper edge left→right, then lower edge right→left. */
function toAreaString(xs: number[], upperYs: number[], lowerYs: number[]): string {
  const upper = xs.map((x, i) => `${x},${upperYs[i]}`);
  const lower = xs.map((x, i) => `${x},${lowerYs[i]}`).reverse();
  return [...upper, ...lower].join(" ");
}

/**
 * Generic stacked-chart geometry: named series in stacking order over a date
 * series. Stacked polygons when every series stays ≥ 0 across the window; the
 * whole window falls back to plain lines otherwise. Returns `null` below the
 * two-point placeholder threshold or for a degenerate time span.
 */
export function buildStackedChartGeometry<Id extends string>(
  dateKeys: string[],
  series: Array<StackedSeriesInput<Id>>,
): StackedChartGeometry<Id> | null {
  if (dateKeys.length < 2) return null;

  const xs = timeProportionalXs(dateKeys, EVOLUTION_CHART_WIDTH, EVOLUTION_CHART_INSET_X);
  if (!xs) return null;

  const stackable = series.every((s) => s.values.every((v) => v >= 0));

  if (!stackable) {
    // Lines mode: each series over one shared padded domain.
    const { yMin, yMax } = paddedValueDomain(series.flatMap((s) => s.values));
    return {
      bands: series.map((s) => ({
        areaPoints: null,
        band: s.band,
        bars: null,
        linePoints: toPointsString(
          xs,
          s.values.map((v) => valueToY(v, yMin, yMax, EVOLUTION_CHART_HEIGHT)),
        ),
      })),
      height: EVOLUTION_CHART_HEIGHT,
      mode: "lines",
      totalLine: null,
      width: EVOLUTION_CHART_WIDTH,
      yMax,
      yMin,
    };
  }

  // Stacked mode: cumulative edges from the zero baseline up; the top edge of
  // the last band is the total. The domain includes the baseline so the stack
  // visibly grows from zero.
  const edges = series.reduce<number[][]>(
    (acc, s) => [...acc, acc.at(-1)!.map((sum, i) => sum + s.values[i]!)],
    [dateKeys.map(() => 0)],
  );
  const { yMin, yMax } = paddedValueDomain([0, ...edges.at(-1)!]);
  const edgeYs = edges.map((edge) =>
    edge.map((v) => valueToY(v, yMin, yMax, EVOLUTION_CHART_HEIGHT)),
  );
  // Evenly-spaced categorical slots for the column chart — one equal slot per
  // period, every bar uniform and centred (ADR 0009). The total line and the
  // band areas/lines ride over these same centres. Lines-mode keeps the
  // time-proportional `xs` above; only the bar path is categorical.
  const { xs: barXs, slotW } = categoricalSlotXs(
    dateKeys.length,
    EVOLUTION_CHART_WIDTH,
    EVOLUTION_CHART_INSET_X,
  );
  const barWidth = barWidthFor(slotW);

  return {
    bands: series.map((s, i) => ({
      areaPoints: toAreaString(barXs, edgeYs[i + 1]!, edgeYs[i]!),
      band: s.band,
      bars: barXs.map((x, p) =>
        toBarRect(x, barWidth, edgeYs[i + 1]![p]!, edgeYs[i]![p]!),
      ),
      linePoints: toPointsString(barXs, edgeYs[i + 1]!),
    })),
    height: EVOLUTION_CHART_HEIGHT,
    mode: "stacked",
    totalLine: toPointsString(barXs, edgeYs.at(-1)!),
    width: EVOLUTION_CHART_WIDTH,
    yMax,
    yMin,
  };
}
