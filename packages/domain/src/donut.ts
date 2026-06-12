/**
 * Donut-chart arc geometry. Pure presentation math (ADR 0009): callers pass
 * tier shares (e.g. largest-remainder percentages) and a ring geometry in
 * viewBox units, and get back per-segment angles plus SVG path data the web
 * layer can render as dumb `<path>` elements. No React or SVG elements here.
 */

export interface DonutGeometry {
  cx: number;
  cy: number;
  outerRadius: number;
  innerRadius: number;
}

export interface DonutArcSegment {
  /** Position of this share in the input array (zero shares are skipped). */
  index: number;
  /** The input share value, echoed back for labels. */
  share: number;
  /** Degrees, 0 at 12 o'clock, increasing clockwise. */
  startAngle: number;
  endAngle: number;
  /** SVG path data for the annular wedge, in viewBox space. */
  path: string;
}

const FULL_CIRCLE = 360;

/** Rounds viewBox coordinates so server-rendered output stays stable. */
function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Maps a clockwise-from-12-o'clock angle in degrees to a point on a circle. */
function pointAt(
  geometry: DonutGeometry,
  radius: number,
  angle: number,
): { x: number; y: number } {
  const radians = ((angle - 90) * Math.PI) / 180;
  return {
    x: round(geometry.cx + radius * Math.cos(radians)),
    y: round(geometry.cy + radius * Math.sin(radians)),
  };
}

/** An annular wedge: outer arc clockwise, inner arc back counterclockwise. */
function wedgePath(
  geometry: DonutGeometry,
  startAngle: number,
  endAngle: number,
): string {
  const { innerRadius, outerRadius } = geometry;
  const largeArc = endAngle - startAngle > 180 ? 1 : 0;
  const outerStart = pointAt(geometry, outerRadius, startAngle);
  const outerEnd = pointAt(geometry, outerRadius, endAngle);
  const innerEnd = pointAt(geometry, innerRadius, endAngle);
  const innerStart = pointAt(geometry, innerRadius, startAngle);

  return [
    `M ${outerStart.x} ${outerStart.y}`,
    `A ${outerRadius} ${outerRadius} 0 ${largeArc} 1 ${outerEnd.x} ${outerEnd.y}`,
    `L ${innerEnd.x} ${innerEnd.y}`,
    `A ${innerRadius} ${innerRadius} 0 ${largeArc} 0 ${innerStart.x} ${innerStart.y}`,
    "Z",
  ].join(" ");
}

/**
 * A full annulus as two closed subpaths: outer circle clockwise, inner circle
 * counterclockwise, so the nonzero fill rule leaves the hole. A single 360°
 * arc would be degenerate (identical endpoints render nothing).
 */
function fullRingPath(geometry: DonutGeometry): string {
  const { innerRadius, outerRadius } = geometry;
  const outerTop = pointAt(geometry, outerRadius, 0);
  const outerBottom = pointAt(geometry, outerRadius, 180);
  const innerTop = pointAt(geometry, innerRadius, 0);
  const innerBottom = pointAt(geometry, innerRadius, 180);

  return [
    `M ${outerTop.x} ${outerTop.y}`,
    `A ${outerRadius} ${outerRadius} 0 1 1 ${outerBottom.x} ${outerBottom.y}`,
    `A ${outerRadius} ${outerRadius} 0 1 1 ${outerTop.x} ${outerTop.y}`,
    "Z",
    `M ${innerTop.x} ${innerTop.y}`,
    `A ${innerRadius} ${innerRadius} 0 1 0 ${innerBottom.x} ${innerBottom.y}`,
    `A ${innerRadius} ${innerRadius} 0 1 0 ${innerTop.x} ${innerTop.y}`,
    "Z",
  ].join(" ");
}

/**
 * Converts an array of non-negative shares into contiguous donut arc segments
 * starting at 12 o'clock and proceeding clockwise. Zero shares produce no
 * segment (and never NaN); a single non-zero share fills the whole ring.
 * All-zero or empty input yields no segments.
 */
export function donutArcSegments(
  shares: number[],
  geometry: DonutGeometry,
): DonutArcSegment[] {
  if (shares.some((share) => share < 0)) {
    throw new Error("Donut shares must be non-negative.");
  }
  if (geometry.innerRadius >= geometry.outerRadius) {
    throw new Error("Donut inner radius must be smaller than the outer radius.");
  }

  const total = shares.reduce((sum, share) => sum + share, 0);
  if (total === 0) return [];

  const segments: DonutArcSegment[] = [];
  let startAngle = 0;

  for (const [index, share] of shares.entries()) {
    if (share === 0) continue;

    const sweep = (share / total) * FULL_CIRCLE;
    const endAngle = startAngle + sweep;
    const isFullRing = sweep >= FULL_CIRCLE;
    segments.push({
      endAngle,
      index,
      path: isFullRing
        ? fullRingPath(geometry)
        : wedgePath(geometry, startAngle, endAngle),
      share,
      startAngle,
    });
    startAngle = endAngle;
  }

  return segments;
}
