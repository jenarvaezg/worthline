import { describe, expect, test } from "vitest";

import {
  buildDecompositionChartGeometry,
  deriveDecompositionBands,
  EVOLUTION_CHART_HEIGHT,
  EVOLUTION_CHART_INSET_X,
  EVOLUTION_CHART_WIDTH,
} from "./index";
import type { DecompositionSeriesPoint } from "./index";

function point(
  dateKey: string,
  totalMinor: number,
  liquidMinor: number,
  housingMinor: number,
): DecompositionSeriesPoint {
  return {
    dateKey,
    housingEquityMinor: housingMinor,
    liquidNetWorthMinor: liquidMinor,
    totalNetWorthMinor: totalMinor,
  };
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

/** Maps a minor-unit value through the geometry's own y domain. */
function yFor(value: number, yMin: number, yMax: number): number {
  return (
    EVOLUTION_CHART_HEIGHT -
    ((value - yMin) / (yMax - yMin)) * EVOLUTION_CHART_HEIGHT
  );
}

describe("deriveDecompositionBands", () => {
  test("rest is net worth minus liquid minus housing, per snapshot", () => {
    const bands = deriveDecompositionBands([
      point("2026-01-01", 1_000_00, 600_00, 300_00),
      point("2026-02-01", 1_100_00, 700_00, 250_00),
    ]);

    expect(bands).toEqual([
      {
        dateKey: "2026-01-01",
        housingMinor: 300_00,
        liquidMinor: 600_00,
        restMinor: 100_00,
      },
      {
        dateKey: "2026-02-01",
        housingMinor: 250_00,
        liquidMinor: 700_00,
        restMinor: 150_00,
      },
    ]);
  });

  test("does not mutate its input", () => {
    const input = [Object.freeze(point("2026-01-01", 1_000_00, 600_00, 300_00))];
    expect(() => deriveDecompositionBands(input)).not.toThrow();
  });
});

describe("buildDecompositionChartGeometry", () => {
  test("returns null with fewer than two snapshots", () => {
    expect(buildDecompositionChartGeometry([])).toBeNull();
    expect(
      buildDecompositionChartGeometry([point("2026-06-01", 1_000_00, 600_00, 300_00)]),
    ).toBeNull();
  });

  test("returns null when every point shares the same date (zero time span)", () => {
    expect(
      buildDecompositionChartGeometry([
        point("2026-06-01", 1_000_00, 600_00, 300_00),
        point("2026-06-01", 1_100_00, 700_00, 300_00),
      ]),
    ).toBeNull();
  });

  test("is a pure function of the snapshot figures — no framing input", () => {
    // Structural invariance: the signature takes only dates and the three
    // headline figures, so the chart cannot differ between Vistas. Two calls
    // with the same input produce identical geometry.
    const points = [
      point("2026-01-01", 1_000_00, 600_00, 300_00),
      point("2026-02-01", 1_100_00, 700_00, 300_00),
    ];
    expect(buildDecompositionChartGeometry(points)).toEqual(
      buildDecompositionChartGeometry(points),
    );
  });

  test("stacks when all bands are non-negative across the window", () => {
    const geometry = buildDecompositionChartGeometry([
      point("2026-01-01", 1_000_00, 600_00, 300_00),
      point("2026-02-01", 1_100_00, 700_00, 300_00),
    ]);

    expect(geometry).not.toBeNull();
    expect(geometry!.mode).toBe("stacked");
    // Bands come in stacking order from the baseline up.
    expect(geometry!.bands.map((b) => b.band)).toEqual(["liquid", "housing", "rest"]);
    for (const band of geometry!.bands) {
      expect(band.areaPoints).not.toBeNull();
    }
  });

  test("stacked bands sum to net worth: the top edge of rest maps the total", () => {
    const points = [
      point("2026-01-01", 1_000_00, 600_00, 300_00),
      point("2026-02-01", 1_100_00, 700_00, 300_00),
    ];
    const geometry = buildDecompositionChartGeometry(points)!;

    const rest = geometry.bands.at(-1)!;
    const topEdge = parseCoords(rest.linePoints);
    expect(topEdge).toHaveLength(points.length);
    for (const [i, { y }] of topEdge.entries()) {
      expect(y).toBeCloseTo(
        yFor(points[i]!.totalNetWorthMinor, geometry.yMin, geometry.yMax),
        1,
      );
    }
  });

  test("adjacent stacked bands share an edge and the stack closes at zero", () => {
    const geometry = buildDecompositionChartGeometry([
      point("2026-01-01", 1_000_00, 600_00, 300_00),
      point("2026-02-01", 1_100_00, 700_00, 300_00),
    ])!;

    const [liquid, housing] = geometry.bands;
    const liquidTop = parseCoords(liquid!.linePoints);
    const housingArea = parseCoords(housing!.areaPoints!);

    // The housing polygon's lower edge is the liquid band's upper edge,
    // traversed right-to-left to close the shape.
    expect(housingArea).toHaveLength(liquidTop.length * 2);
    expect(housingArea.slice(liquidTop.length)).toEqual([...liquidTop].reverse());

    // The liquid polygon closes down to the zero baseline.
    const liquidArea = parseCoords(liquid!.areaPoints!);
    const baselineY = yFor(0, geometry.yMin, geometry.yMax);
    for (const { y } of liquidArea.slice(liquidTop.length)) {
      expect(y).toBeCloseTo(baselineY, 1);
    }
  });

  test("a band sitting exactly at zero still stacks", () => {
    // rest = 0 on both snapshots: zero is not "crossing below zero".
    const geometry = buildDecompositionChartGeometry([
      point("2026-01-01", 900_00, 600_00, 300_00),
      point("2026-02-01", 1_000_00, 700_00, 300_00),
    ]);
    expect(geometry!.mode).toBe("stacked");
  });

  test("a single negative band value anywhere flips the whole window to lines", () => {
    // rest is negative only on the middle snapshot.
    const geometry = buildDecompositionChartGeometry([
      point("2026-01-01", 1_000_00, 600_00, 300_00),
      point("2026-01-15", 800_00, 600_00, 300_00),
      point("2026-02-01", 1_100_00, 700_00, 300_00),
    ])!;

    expect(geometry.mode).toBe("lines");
    for (const band of geometry.bands) {
      expect(band.areaPoints).toBeNull();
    }
  });

  test("a negative housing equity also triggers the lines fallback", () => {
    const geometry = buildDecompositionChartGeometry([
      point("2026-01-01", 1_000_00, 600_00, -50_00),
      point("2026-02-01", 1_100_00, 700_00, 300_00),
    ])!;
    expect(geometry.mode).toBe("lines");
  });

  test("lines mode plots each band's own series through the padded y domain", () => {
    const points = [
      point("2026-01-01", 1_000_00, 600_00, 300_00),
      point("2026-01-15", 800_00, 600_00, 300_00),
      point("2026-02-01", 1_100_00, 700_00, 300_00),
    ];
    const geometry = buildDecompositionChartGeometry(points)!;
    const bands = deriveDecompositionBands(points);

    const liquidLine = parseCoords(geometry.bands[0]!.linePoints);
    const restLine = parseCoords(geometry.bands[2]!.linePoints);
    for (const [i, band] of bands.entries()) {
      expect(liquidLine[i]!.y).toBeCloseTo(
        yFor(band.liquidMinor, geometry.yMin, geometry.yMax),
        1,
      );
      expect(restLine[i]!.y).toBeCloseTo(
        yFor(band.restMinor, geometry.yMin, geometry.yMax),
        1,
      );
    }
  });

  test("x positions are time-proportional and shared across bands", () => {
    const geometry = buildDecompositionChartGeometry([
      point("2026-01-01", 1_000_00, 600_00, 300_00),
      point("2026-01-02", 1_050_00, 620_00, 300_00),
      point("2026-01-04", 1_100_00, 700_00, 300_00),
    ])!;

    const innerWidth = EVOLUTION_CHART_WIDTH - 2 * EVOLUTION_CHART_INSET_X;
    for (const band of geometry.bands) {
      const coords = parseCoords(band.linePoints);
      expect(coords[0]!.x).toBeCloseTo(EVOLUTION_CHART_INSET_X, 1);
      expect(coords[1]!.x).toBeCloseTo(EVOLUTION_CHART_INSET_X + innerWidth / 3, 1);
      expect(coords[2]!.x).toBeCloseTo(EVOLUTION_CHART_INSET_X + innerWidth, 1);
    }
  });
});
