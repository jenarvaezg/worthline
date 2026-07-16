import { describe, expect, test } from "vitest";

import {
  EXPOSURE_DEFENSIVE_SECTORS,
  EXPOSURE_SECTOR_BUCKETS,
  type ExposureSectorBucket,
  sectorStyleSplit,
} from "./exposure-taxonomy";

describe("sector taxonomy", () => {
  test("has the 11 GICS level-1 sectors", () => {
    expect(EXPOSURE_SECTOR_BUCKETS).toHaveLength(11);
  });

  test("the defensive set is a subset of the canonical buckets", () => {
    for (const sector of EXPOSURE_DEFENSIVE_SECTORS) {
      expect(EXPOSURE_SECTOR_BUCKETS).toContain(sector);
    }
    expect(EXPOSURE_DEFENSIVE_SECTORS).toEqual(
      new Set<ExposureSectorBucket>(["consumer_staples", "utilities", "health_care"]),
    );
  });
});

describe("sectorStyleSplit", () => {
  test("splits a full vector into defensive vs cyclical, summing to the coverage", () => {
    expect(
      sectorStyleSplit({
        consumer_staples: "0.2",
        utilities: "0.1",
        health_care: "0.1",
        information_technology: "0.4",
        financials: "0.2",
      }),
    ).toEqual({ cyclical: "0.6", defensive: "0.4" });
  });

  test("a partial (under-100%) vector keeps its declared coverage, never renormalises", () => {
    // Only 60% classified — the derived split reflects that, not a fabricated 100%.
    expect(
      sectorStyleSplit({ health_care: "0.3", information_technology: "0.3" }),
    ).toEqual({ cyclical: "0.3", defensive: "0.3" });
  });

  test("a purely defensive vector yields zero cyclical", () => {
    expect(sectorStyleSplit({ consumer_staples: "0.5", utilities: "0.5" })).toEqual({
      cyclical: "0",
      defensive: "1",
    });
  });

  test("a purely cyclical vector yields zero defensive", () => {
    expect(sectorStyleSplit({ energy: "0.5", real_estate: "0.5" })).toEqual({
      cyclical: "1",
      defensive: "0",
    });
  });

  test("an empty vector yields zero on both sides", () => {
    expect(sectorStyleSplit({})).toEqual({ cyclical: "0", defensive: "0" });
  });

  test("ignores null/absent weights (untyped breakdownsJson storage)", () => {
    // The vector is read from generic `breakdownsJson`, so a stored null weight
    // is plausible even though the typed surface forbids it.
    const stored = { health_care: null, financials: "0.5" } as unknown as Parameters<
      typeof sectorStyleSplit
    >[0];
    expect(sectorStyleSplit(stored)).toEqual({ cyclical: "0.5", defensive: "0" });
  });
});
