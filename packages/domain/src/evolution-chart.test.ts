import { describe, expect, test } from "vitest";

import {
  buildEvolutionChartGeometry,
  EVOLUTION_CHART_HEIGHT,
  EVOLUTION_CHART_INSET_X,
  EVOLUTION_CHART_WIDTH,
} from "./index";
import type { EvolutionSeriesPoint } from "./index";

function point(
  dateKey: string,
  valueMinor: number,
  isMonthlyClose = false,
): EvolutionSeriesPoint {
  return { dateKey, isMonthlyClose, valueMinor };
}

function parseCoords(points: string): Array<{ x: number; y: number }> {
  return points
    .trim()
    .split(" ")
    .map((pair) => {
      const [x, y] = pair.split(",");
      return { x: Number(x), y: Number(y) };
    });
}

describe("buildEvolutionChartGeometry", () => {
  test("returns null with fewer than two snapshots", () => {
    expect(buildEvolutionChartGeometry([])).toBeNull();
    expect(buildEvolutionChartGeometry([point("2026-06-01", 100_00)])).toBeNull();
  });

  test("returns null when every point shares the same date (zero time span)", () => {
    expect(
      buildEvolutionChartGeometry([
        point("2026-06-01", 100_00),
        point("2026-06-01", 200_00),
      ]),
    ).toBeNull();
  });

  test("x positions are proportional to real dates — gaps widen segments", () => {
    const geometry = buildEvolutionChartGeometry([
      point("2026-01-01", 100_00),
      point("2026-01-02", 110_00),
      point("2026-01-04", 120_00),
    ]);

    expect(geometry).not.toBeNull();
    const coords = parseCoords(geometry!.linePoints);
    expect(coords).toHaveLength(3);

    const innerWidth = EVOLUTION_CHART_WIDTH - 2 * EVOLUTION_CHART_INSET_X;
    // Day 0 of 3 → left inset; day 1 of 3 → one third; day 3 of 3 → right edge.
    expect(coords[0]!.x).toBeCloseTo(EVOLUTION_CHART_INSET_X, 1);
    expect(coords[1]!.x).toBeCloseTo(EVOLUTION_CHART_INSET_X + innerWidth / 3, 1);
    expect(coords[2]!.x).toBeCloseTo(EVOLUTION_CHART_INSET_X + innerWidth, 1);

    // The 2-day gap is exactly twice as long as the 1-day segment.
    const firstSegment = coords[1]!.x - coords[0]!.x;
    const secondSegment = coords[2]!.x - coords[1]!.x;
    expect(secondSegment).toBeCloseTo(firstSegment * 2, 1);
  });

  test("y auto-scales over the data range with ~10% padding, not from zero", () => {
    const geometry = buildEvolutionChartGeometry([
      point("2026-01-01", 100_000),
      point("2026-02-01", 200_000),
    ]);

    expect(geometry).not.toBeNull();
    // Padded domain: range 100k → pad 10k on each side.
    expect(geometry!.yMin).toBe(90_000);
    expect(geometry!.yMax).toBe(210_000);

    const coords = parseCoords(geometry!.linePoints);
    // The max value sits below the top edge, the min above the bottom edge.
    expect(coords[1]!.y).toBeGreaterThan(0);
    expect(coords[1]!.y).toBeLessThan(coords[0]!.y);
    expect(coords[0]!.y).toBeLessThan(EVOLUTION_CHART_HEIGHT);
    // Scale is anchored to the data range, not zero: 100k maps near the
    // bottom (10/120 of the height from the edge), not at 100/210 of it.
    expect(coords[0]!.y).toBeCloseTo(
      EVOLUTION_CHART_HEIGHT - (10_000 / 120_000) * EVOLUTION_CHART_HEIGHT,
      1,
    );
  });

  test("a flat series stays inside the viewBox without dividing by zero", () => {
    const geometry = buildEvolutionChartGeometry([
      point("2026-01-01", 50_000),
      point("2026-01-15", 50_000),
      point("2026-02-01", 50_000),
    ]);

    expect(geometry).not.toBeNull();
    for (const { y } of parseCoords(geometry!.linePoints)) {
      expect(Number.isFinite(y)).toBe(true);
      expect(y).toBeGreaterThan(0);
      expect(y).toBeLessThan(EVOLUTION_CHART_HEIGHT);
    }
  });

  test("only monthly closes become markers, carrying date and value", () => {
    const geometry = buildEvolutionChartGeometry([
      point("2026-01-15", 100_00),
      point("2026-01-31", 150_00, true),
      point("2026-02-10", 130_00),
      point("2026-02-28", 180_00, true),
    ]);

    expect(geometry).not.toBeNull();
    expect(geometry!.markers).toHaveLength(2);
    expect(geometry!.markers[0]).toMatchObject({
      dateKey: "2026-01-31",
      valueMinor: 150_00,
    });
    expect(geometry!.markers[1]).toMatchObject({
      dateKey: "2026-02-28",
      valueMinor: 180_00,
    });

    // Markers sit exactly on the polyline.
    const coords = parseCoords(geometry!.linePoints);
    expect(geometry!.markers[0]!.x).toBe(coords[1]!.x);
    expect(geometry!.markers[0]!.y).toBe(coords[1]!.y);
  });

  test("area points close the polygon down to the baseline", () => {
    const geometry = buildEvolutionChartGeometry([
      point("2026-01-01", 100_00),
      point("2026-01-10", 120_00),
    ]);

    expect(geometry).not.toBeNull();
    const line = parseCoords(geometry!.linePoints);
    const area = parseCoords(geometry!.areaPoints);

    // Same vertices plus the two baseline corners.
    expect(area).toHaveLength(line.length + 2);
    expect(area.at(-2)).toEqual({ x: line.at(-1)!.x, y: EVOLUTION_CHART_HEIGHT });
    expect(area.at(-1)).toEqual({ x: line[0]!.x, y: EVOLUTION_CHART_HEIGHT });
  });
});
