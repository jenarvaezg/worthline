/**
 * Evolution chart geometry — pure presentation math for the home's
 * server-rendered SVG area chart (ADR 0009).
 *
 * Maps a snapshot series (dates + minor-unit values) to viewBox-space
 * primitives: time-PROPORTIONAL x positions (capture gaps appear as longer
 * segments), a y scale auto-fitted to the data range with ~10% padding
 * (never anchored at zero), polyline/area point strings, and monthly-close
 * marker positions. No React, no SVG — just numbers and strings.
 */

export interface EvolutionSeriesPoint {
  /** Calendar day of the capture, YYYY-MM-DD. */
  dateKey: string;
  /** Plotted value in integer minor units (headline figure of the framing). */
  valueMinor: number;
  /** Whether this point is the derived monthly close of its month. */
  isMonthlyClose: boolean;
}

export interface EvolutionMarker {
  x: number;
  y: number;
  dateKey: string;
  valueMinor: number;
}

export interface EvolutionChartGeometry {
  width: number;
  height: number;
  /** Polyline vertices as an SVG points string: "x,y x,y …". */
  linePoints: string;
  /** Line vertices closed down to the baseline, for the gradient-fill polygon. */
  areaPoints: string;
  /** Monthly-close positions, in series order. */
  markers: EvolutionMarker[];
  /** Padded value domain (minor units) the y scale maps from. */
  yMin: number;
  yMax: number;
}

export const EVOLUTION_CHART_WIDTH = 600;
export const EVOLUTION_CHART_HEIGHT = 160;
/** Horizontal inset so edge markers are not clipped by the viewBox. */
export const EVOLUTION_CHART_INSET_X = 4;

/** Fraction of the data range added as headroom above and below. */
const Y_PADDING_RATIO = 0.1;

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Time-proportional x positions for a date series: capture gaps appear as
 * longer segments. Returns `null` for a degenerate zero-length time span or
 * unparseable dates.
 */
export function timeProportionalXs(
  dateKeys: string[],
  width: number,
  insetX: number,
): number[] | null {
  const times = dateKeys.map((d) => Date.parse(`${d}T00:00:00Z`));
  const t0 = Math.min(...times);
  const span = Math.max(...times) - t0;

  if (span <= 0 || times.some((t) => Number.isNaN(t))) return null;

  const innerWidth = width - 2 * insetX;
  return times.map((t) => round2(insetX + ((t - t0) / span) * innerWidth));
}

/**
 * Value domain fitted to the data range with ~10% padding on both sides
 * (never anchored at zero). Flat series still get headroom so the line sits
 * mid-chart instead of on an edge; the fallback pad scales with the value.
 */
export function paddedValueDomain(values: number[]): { yMin: number; yMax: number } {
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min;
  const pad =
    range > 0 ? range * Y_PADDING_RATIO : Math.max(Math.abs(max), 1) * Y_PADDING_RATIO;
  return { yMax: max + pad, yMin: min - pad };
}

/** Maps a minor-unit value into viewBox y space (top = yMax, bottom = yMin). */
export function valueToY(
  value: number,
  yMin: number,
  yMax: number,
  height: number,
): number {
  return round2(height - ((value - yMin) / (yMax - yMin)) * height);
}

/**
 * Builds the chart geometry for a snapshot series, or `null` when there is
 * no chart to draw: fewer than two points (the placeholder threshold) or a
 * degenerate zero-length time span.
 */
export function buildEvolutionChartGeometry(
  points: EvolutionSeriesPoint[],
): EvolutionChartGeometry | null {
  if (points.length < 2) return null;

  const xs = timeProportionalXs(
    points.map((p) => p.dateKey),
    EVOLUTION_CHART_WIDTH,
    EVOLUTION_CHART_INSET_X,
  );
  if (!xs) return null;

  const { yMin, yMax } = paddedValueDomain(points.map((p) => p.valueMinor));

  const coords = points.map((p, i) => ({
    x: xs[i]!,
    y: valueToY(p.valueMinor, yMin, yMax, EVOLUTION_CHART_HEIGHT),
  }));

  const linePoints = coords.map(({ x, y }) => `${x},${y}`).join(" ");
  const areaPoints = [
    linePoints,
    `${coords.at(-1)!.x},${EVOLUTION_CHART_HEIGHT}`,
    `${coords[0]!.x},${EVOLUTION_CHART_HEIGHT}`,
  ].join(" ");

  const markers = points.flatMap((p, i) =>
    p.isMonthlyClose
      ? [
          {
            dateKey: p.dateKey,
            valueMinor: p.valueMinor,
            x: coords[i]!.x,
            y: coords[i]!.y,
          },
        ]
      : [],
  );

  return {
    areaPoints,
    height: EVOLUTION_CHART_HEIGHT,
    linePoints,
    markers,
    width: EVOLUTION_CHART_WIDTH,
    yMax,
    yMin,
  };
}
