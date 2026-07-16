import { describe, expect, it } from "vitest";

import {
  BALANCE_SERIES_GOLDEN_FIXTURES,
  BALANCE_SERIES_GOLDEN_SCENARIOS,
  EXTRACTOR_GOLDEN_FIXTURES,
  EXTRACTOR_GOLDEN_SCENARIOS,
} from "./manifest";
import {
  localExtractorGoldenRoot,
  resolveBalanceSeriesExpectedPath,
  resolveFixtureExpectedPath,
} from "./paths";

describe("extractor golden manifest", () => {
  it("covers every required scenario exactly once", () => {
    const seen = new Set(EXTRACTOR_GOLDEN_FIXTURES.map((fixture) => fixture.scenario));
    expect([...seen].sort()).toEqual([...EXTRACTOR_GOLDEN_SCENARIOS].sort());
  });

  it("keeps private fixtures under .local/extractor-golden", () => {
    for (const fixture of EXTRACTOR_GOLDEN_FIXTURES.filter(
      (candidate) => candidate.storage === "local",
    )) {
      expect(resolveFixtureExpectedPath(fixture)).toMatch(
        new RegExp(`${localExtractorGoldenRoot().replaceAll("/", "\\/")}/`),
      );
    }
  });

  it("covers every balance-series scenario exactly once", () => {
    const seen = new Set(
      BALANCE_SERIES_GOLDEN_FIXTURES.map((fixture) => fixture.scenario),
    );
    expect([...seen].sort()).toEqual([...BALANCE_SERIES_GOLDEN_SCENARIOS].sort());
  });

  it("keeps every balance-series PDF fixture private under .local", () => {
    for (const fixture of BALANCE_SERIES_GOLDEN_FIXTURES) {
      expect(fixture.storage).toBe("local");
      expect(resolveBalanceSeriesExpectedPath(fixture)).toMatch(
        new RegExp(`${localExtractorGoldenRoot().replaceAll("/", "\\/")}/`),
      );
    }
  });
});
