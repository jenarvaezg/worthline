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
 * Builds the chart geometry for a snapshot series, or `null` when there is
 * no chart to draw: fewer than two points (the placeholder threshold) or a
 * degenerate zero-length time span.
 */
export function buildEvolutionChartGeometry(
  points: EvolutionSeriesPoint[],
): EvolutionChartGeometry | null {
  if (points.length < 2) return null;

  const times = points.map((p) => Date.parse(`${p.dateKey}T00:00:00Z`));
  const t0 = Math.min(...times);
  const span = Math.max(...times) - t0;

  if (span <= 0 || times.some((t) => Number.isNaN(t))) return null;

  const values = points.map((p) => p.valueMinor);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min;
  // Flat series still get headroom so the line sits mid-chart instead of on
  // an edge; scale the fallback to the magnitude of the value.
  const pad =
    range > 0 ? range * Y_PADDING_RATIO : Math.max(Math.abs(max), 1) * Y_PADDING_RATIO;
  const yMin = min - pad;
  const yMax = max + pad;

  const innerWidth = EVOLUTION_CHART_WIDTH - 2 * EVOLUTION_CHART_INSET_X;

  const coords = points.map((p, i) => ({
    x: round2(EVOLUTION_CHART_INSET_X + ((times[i]! - t0) / span) * innerWidth),
    y: round2(
      EVOLUTION_CHART_HEIGHT -
        ((p.valueMinor - yMin) / (yMax - yMin)) * EVOLUTION_CHART_HEIGHT,
    ),
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
