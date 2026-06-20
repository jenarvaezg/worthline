/**
 * Shared chart-geometry primitives — pure presentation math for the home's
 * server-rendered SVG charts (ADR 0009). Maps a date/value series into viewBox
 * space: time-PROPORTIONAL x positions (capture gaps appear as longer
 * segments), a y scale auto-fitted to a value range with ~10% padding, and the
 * value→y projection. Shared by the composition chart (#142) and the stacked
 * geometry behind the drilldown. No React, no SVG — just numbers.
 *
 * (The file keeps the `evolution-chart` name for history: the standalone
 * evolution area chart was folded into the composition chart in #142, leaving
 * these primitives in place.)
 */

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
 * Evenly-spaced CATEGORICAL x positions for a column chart: one equal slot per
 * period, each bar centred in its own slot with half-slot margins at both edges
 * so no column ever clips the viewBox. Used by the stacked-bar charts (the
 * composition chart and the drilldown aggregate) — irregular capture spacing is
 * ignored on purpose, since a stacked column chart reads cleanly only when every
 * column is uniform (matches the reference spreadsheet). Returns the slot width
 * alongside the centres so callers can size bars off the same slot.
 */
export function categoricalSlotXs(
  count: number,
  width: number,
  insetX: number,
): { xs: number[]; slotW: number } {
  const slotW = (width - 2 * insetX) / count;
  const xs = Array.from({ length: count }, (_, i) => round2(insetX + slotW * (i + 0.5)));
  return { slotW, xs };
}

/**
 * Value domain fitted to the data range with ~10% padding on both sides
 * (never anchored at zero unless zero is in the range). Flat series still get
 * headroom so the line sits mid-chart instead of on an edge; the fallback pad
 * scales with the value.
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
