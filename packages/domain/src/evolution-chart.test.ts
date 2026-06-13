/**
 * Shared chart-geometry primitives (ADR 0009): time-proportional x, the padded
 * value domain, and the value→y projection used by the composition chart (#142)
 * and the stacked geometry behind the drilldown.
 */
import { describe, expect, test } from "vitest";

import {
  EVOLUTION_CHART_HEIGHT,
  EVOLUTION_CHART_INSET_X,
  EVOLUTION_CHART_WIDTH,
  paddedValueDomain,
  timeProportionalXs,
  valueToY,
} from "./evolution-chart";

describe("timeProportionalXs", () => {
  test("returns null for a degenerate zero-length time span", () => {
    expect(
      timeProportionalXs(
        ["2026-06-01", "2026-06-01"],
        EVOLUTION_CHART_WIDTH,
        EVOLUTION_CHART_INSET_X,
      ),
    ).toBeNull();
  });

  test("returns null for unparseable dates", () => {
    expect(
      timeProportionalXs(
        ["nope", "2026-06-02"],
        EVOLUTION_CHART_WIDTH,
        EVOLUTION_CHART_INSET_X,
      ),
    ).toBeNull();
  });

  test("x positions are proportional to real dates — gaps widen segments", () => {
    const xs = timeProportionalXs(
      ["2026-01-01", "2026-01-02", "2026-01-04"],
      EVOLUTION_CHART_WIDTH,
      EVOLUTION_CHART_INSET_X,
    )!;

    expect(xs).toHaveLength(3);
    const innerWidth = EVOLUTION_CHART_WIDTH - 2 * EVOLUTION_CHART_INSET_X;
    // Day 0 of 3 → left inset; day 1 of 3 → one third; day 3 of 3 → right edge.
    expect(xs[0]!).toBeCloseTo(EVOLUTION_CHART_INSET_X, 1);
    expect(xs[1]!).toBeCloseTo(EVOLUTION_CHART_INSET_X + innerWidth / 3, 1);
    expect(xs[2]!).toBeCloseTo(EVOLUTION_CHART_INSET_X + innerWidth, 1);
    // The 2-day gap is exactly twice as long as the 1-day segment.
    expect(xs[2]! - xs[1]!).toBeCloseTo((xs[1]! - xs[0]!) * 2, 1);
  });
});

describe("paddedValueDomain", () => {
  test("pads the data range by ~10% on each side", () => {
    expect(paddedValueDomain([100_000, 200_000])).toEqual({
      yMax: 210_000,
      yMin: 90_000,
    });
  });

  test("a flat series still gets headroom instead of a zero-height domain", () => {
    const { yMax, yMin } = paddedValueDomain([50_000, 50_000, 50_000]);
    expect(yMax).toBeGreaterThan(50_000);
    expect(yMin).toBeLessThan(50_000);
  });
});

describe("valueToY", () => {
  test("maps the domain max to the top and the min to the bottom of the viewBox", () => {
    expect(valueToY(210_000, 90_000, 210_000, EVOLUTION_CHART_HEIGHT)).toBeCloseTo(0, 1);
    expect(valueToY(90_000, 90_000, 210_000, EVOLUTION_CHART_HEIGHT)).toBeCloseTo(
      EVOLUTION_CHART_HEIGHT,
      1,
    );
  });

  test("anchors to the data range, not zero", () => {
    // 100k in a [90k, 210k] domain sits 10/120 of the height up from the bottom.
    expect(valueToY(100_000, 90_000, 210_000, EVOLUTION_CHART_HEIGHT)).toBeCloseTo(
      EVOLUTION_CHART_HEIGHT - (10_000 / 120_000) * EVOLUTION_CHART_HEIGHT,
      1,
    );
  });
});
