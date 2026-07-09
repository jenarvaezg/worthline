import { describe, expect, test } from "vitest";

import {
  COMPOSITION_MODES,
  cellKey,
  crossOf,
  MAX_REQUESTED_CELLS,
  type MatrixCoord,
  missingCells,
  parseCellsParam,
  parseMode,
} from "./dashboard-matrix";

/**
 * The pure matrix vocabulary behind the cross-prefetch (S4 #520, ADR 0038): the
 * cell key, the "cross" of a cell (the cells one click away — same column + same
 * row), and the prefetch diff. Kept pure so the SERVER (initial-ship) and the
 * CLIENT (prefetch) compute the exact same set, and it unit-tests in node.
 */

const keys = (coords: readonly MatrixCoord[]): string[] => coords.map(cellKey).sort();

describe("cellKey", () => {
  test("is a stable mode:range string", () => {
    expect(cellKey({ mode: "liquid", range: "3y" })).toBe("liquid:3y");
    expect(cellKey({ mode: "chart", range: "all" })).toBe("chart:all");
  });
});

describe("COMPOSITION_MODES", () => {
  test("is the chart plus the four drilldowns", () => {
    expect([...COMPOSITION_MODES]).toEqual([
      "chart",
      "liquid",
      "rest",
      "housing",
      "debts",
    ]);
  });
});

describe("parseMode", () => {
  test("maps a drill key to its mode and a missing/invalid drill to chart", () => {
    expect(parseMode("liquid")).toBe("liquid");
    expect(parseMode("debts")).toBe("debts");
    expect(parseMode(null)).toBe("chart");
    expect(parseMode("bogus")).toBe("chart");
  });
});

describe("crossOf", () => {
  test("is the full column (every mode at the range) + the full row (the mode at every range)", () => {
    const cross = crossOf({ mode: "chart", range: "all" }, ["1y", "3y", "5y", "all"]);
    // column: 5 modes at `all`; row: chart at the 3 other ranges → 8 cells, deduped.
    expect(keys(cross)).toEqual(
      [
        "chart:1y",
        "chart:3y",
        "chart:5y",
        "chart:all",
        "debts:all",
        "housing:all",
        "liquid:all",
        "rest:all",
      ].sort(),
    );
  });

  test("centres on a drill cell the same way", () => {
    const cross = crossOf({ mode: "liquid", range: "3y" }, ["1y", "3y", "5y", "all"]);
    expect(keys(cross)).toEqual(
      [
        "chart:3y",
        "liquid:3y",
        "rest:3y",
        "housing:3y",
        "debts:3y",
        "liquid:1y",
        "liquid:5y",
        "liquid:all",
      ].sort(),
    );
  });

  test("shrinks with the offered ranges", () => {
    const cross = crossOf({ mode: "chart", range: "1y" }, ["1y", "all"]);
    // column: 5 modes at 1y; row: chart at 1y + all → 6 cells.
    expect(keys(cross)).toEqual(
      ["chart:1y", "liquid:1y", "rest:1y", "housing:1y", "debts:1y", "chart:all"].sort(),
    );
  });

  test("always includes the active cell even when its range is not offered (deep-link safety)", () => {
    const cross = crossOf({ mode: "chart", range: "5y" }, ["1y", "all"]);
    expect(keys(cross)).toContain("chart:5y");
    // the column still covers every mode at the active (unoffered) range
    expect(keys(cross)).toContain("liquid:5y");
    // and the row still reaches the offered ranges
    expect(keys(cross)).toContain("chart:1y");
    expect(keys(cross)).toContain("chart:all");
  });

  test("never duplicates the centre cell", () => {
    const cross = crossOf({ mode: "chart", range: "all" }, ["all"]);
    expect(keys(cross)).toEqual(
      ["chart:all", "liquid:all", "rest:all", "housing:all", "debts:all"].sort(),
    );
  });
});

describe("missingCells", () => {
  test("returns the wanted cells absent from the have-set, by key", () => {
    const want: MatrixCoord[] = [
      { mode: "chart", range: "1y" },
      { mode: "liquid", range: "1y" },
      { mode: "debts", range: "1y" },
    ];
    const have = new Set(["chart:1y", "debts:1y"]);
    expect(missingCells(want, have)).toEqual([{ mode: "liquid", range: "1y" }]);
  });

  test("returns nothing when everything is cached", () => {
    const want: MatrixCoord[] = [{ mode: "chart", range: "all" }];
    expect(missingCells(want, new Set(["chart:all"]))).toEqual([]);
  });
});

describe("parseCellsParam", () => {
  test("parses a comma-separated list of mode:range keys, deduped", () => {
    const result = parseCellsParam("chart:all,liquid:3y,chart:all");
    expect(result).toEqual({
      ok: true,
      coords: [
        { mode: "chart", range: "all" },
        { mode: "liquid", range: "3y" },
      ],
    });
  });

  test("rejects an unknown mode or range", () => {
    expect(parseCellsParam("bogus:all").ok).toBe(false);
    expect(parseCellsParam("chart:decade").ok).toBe(false);
    expect(parseCellsParam("chart").ok).toBe(false);
    expect(parseCellsParam("chart:all:extra").ok).toBe(false);
  });

  test("rejects an empty request", () => {
    expect(parseCellsParam("").ok).toBe(false);
    expect(parseCellsParam(null).ok).toBe(false);
    expect(parseCellsParam("  ,  ").ok).toBe(false);
  });

  test("rejects more cells than the matrix can hold", () => {
    const tooMany = Array.from(
      { length: MAX_REQUESTED_CELLS + 1 },
      (_, i) => `chart:all${i}`,
    ).join(",");
    // (the tokens are also invalid, but the count guard trips first)
    expect(parseCellsParam(tooMany).ok).toBe(false);
  });
});
