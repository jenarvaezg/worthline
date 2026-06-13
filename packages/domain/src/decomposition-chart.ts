/**
 * Generic stacked-chart geometry — pure presentation math for server-rendered
 * stacked SVGs (ADR 0009). Named series in stacking order over a shared date
 * series: stacked polygons when every series stays ≥ 0 across the window, an
 * honest fall back to plain lines otherwise. Shared by the drilldown per-tier
 * stack (#76/#77); the home's net-worth composition chart (#142) has its own
 * bidirectional geometry. No React, no SVG — just numbers and strings.
 *
 * (The file keeps the `decomposition-chart` name for history: the standalone
 * decomposition chart was folded into the composition chart in #142, leaving
 * this generic engine in place.)
 */

import {
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

export interface StackedBandGeometry<Id extends string> {
  band: Id;
  /**
   * Stacked mode: closed polygon between the band's lower and upper stack
   * edges (upper edge left→right, then lower edge right→left). `null` in
   * lines mode.
   */
  areaPoints: string | null;
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
  /** Value domain (minor units) the y scale maps from. */
  yMin: number;
  yMax: number;
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
        linePoints: toPointsString(
          xs,
          s.values.map((v) => valueToY(v, yMin, yMax, EVOLUTION_CHART_HEIGHT)),
        ),
      })),
      height: EVOLUTION_CHART_HEIGHT,
      mode: "lines",
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

  return {
    bands: series.map((s, i) => ({
      areaPoints: toAreaString(xs, edgeYs[i + 1]!, edgeYs[i]!),
      band: s.band,
      linePoints: toPointsString(xs, edgeYs[i + 1]!),
    })),
    height: EVOLUTION_CHART_HEIGHT,
    mode: "stacked",
    width: EVOLUTION_CHART_WIDTH,
    yMax,
    yMin,
  };
}
