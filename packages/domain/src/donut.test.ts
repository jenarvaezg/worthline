import { describe, expect, test } from "vitest";

import { donutArcSegments } from "./index";

const geometry = { cx: 50, cy: 50, innerRadius: 27, outerRadius: 45 };

describe("donutArcSegments", () => {
  test("returns no segments for empty input", () => {
    expect(donutArcSegments([], geometry)).toEqual([]);
  });

  test("returns no segments when every share is zero", () => {
    expect(donutArcSegments([0, 0, 0, 0, 0], geometry)).toEqual([]);
  });

  test("splits four equal shares into contiguous 90° arcs starting at 12 o'clock", () => {
    const segments = donutArcSegments([25, 25, 25, 25], geometry);

    expect(segments).toHaveLength(4);
    expect(segments.map((s) => s.startAngle)).toEqual([0, 90, 180, 270]);
    expect(segments.map((s) => s.endAngle)).toEqual([90, 180, 270, 360]);
    expect(segments.map((s) => s.index)).toEqual([0, 1, 2, 3]);
    expect(segments.map((s) => s.share)).toEqual([25, 25, 25, 25]);
  });

  test("produces the expected wedge path for a 90° segment", () => {
    const [first] = donutArcSegments([25, 25, 25, 25], geometry);

    // Top of the ring (50, 5) clockwise to the right (95, 50), then back
    // along the inner radius counterclockwise.
    expect(first!.path).toBe(
      "M 50 5 A 45 45 0 0 1 95 50 L 77 50 A 27 27 0 0 0 50 23 Z",
    );
  });

  test("keeps sweeps proportional and summing to a full circle", () => {
    const segments = donutArcSegments([40, 30, 20, 10], geometry);

    const sweeps = segments.map((s) => s.endAngle - s.startAngle);
    expect(sweeps).toEqual([144, 108, 72, 36]);
    expect(sweeps.reduce((a, b) => a + b, 0)).toBe(360);
  });

  test("skips zero shares without breaking contiguity or producing NaN", () => {
    const segments = donutArcSegments([50, 0, 50, 0, 0], geometry);

    expect(segments.map((s) => s.index)).toEqual([0, 2]);
    expect(segments[0]!.startAngle).toBe(0);
    expect(segments[0]!.endAngle).toBe(180);
    expect(segments[1]!.startAngle).toBe(180);
    expect(segments[1]!.endAngle).toBe(360);
    for (const segment of segments) {
      expect(segment.path).not.toContain("NaN");
    }
  });

  test("uses the large-arc flag for sweeps over 180°", () => {
    const segments = donutArcSegments([75, 25], geometry);

    expect(segments[0]!.path).toContain("A 45 45 0 1 1");
    expect(segments[1]!.path).toContain("A 45 45 0 0 1");
  });

  test("renders a single 100% share as a full ring", () => {
    const segments = donutArcSegments([0, 100, 0, 0, 0], geometry);

    expect(segments).toHaveLength(1);
    expect(segments[0]!.index).toBe(1);
    expect(segments[0]!.startAngle).toBe(0);
    expect(segments[0]!.endAngle).toBe(360);
    // A full ring is two closed subpaths (outer clockwise, inner
    // counterclockwise) so the annulus fills without degenerate arcs.
    expect(segments[0]!.path.match(/M /g)).toHaveLength(2);
    expect(segments[0]!.path.match(/A /g)).toHaveLength(4);
    expect(segments[0]!.path).not.toContain("NaN");
  });

  test("matches largest-remainder percentages end to end", () => {
    const shares = [3334, 3333, 3333, 0, 0];
    const segments = donutArcSegments(shares, geometry);

    const sweeps = segments.map((s) => s.endAngle - s.startAngle);
    expect(sweeps.reduce((a, b) => a + b, 0)).toBeCloseTo(360, 6);
    expect(segments.at(-1)!.endAngle).toBe(360);
  });

  test("rejects negative shares", () => {
    expect(() => donutArcSegments([50, -10, 60], geometry)).toThrow(
      "Donut shares must be non-negative.",
    );
  });

  test("rejects an inner radius that is not smaller than the outer radius", () => {
    expect(() =>
      donutArcSegments([100], { cx: 50, cy: 50, innerRadius: 45, outerRadius: 45 }),
    ).toThrow("Donut inner radius must be smaller than the outer radius.");
  });
});
