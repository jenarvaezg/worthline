import { describe, expect, it } from "vitest";

import { EXTRACTOR_GOLDEN_FIXTURES, EXTRACTOR_GOLDEN_SCENARIOS } from "./manifest";
import { localExtractorGoldenRoot, resolveFixtureExpectedPath } from "./paths";

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
});
