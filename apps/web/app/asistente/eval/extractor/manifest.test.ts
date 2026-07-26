import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  BALANCE_SERIES_GOLDEN_FIXTURES,
  BALANCE_SERIES_GOLDEN_SCENARIOS,
  EXTRACTOR_GOLDEN_FIXTURES,
  EXTRACTOR_GOLDEN_SCENARIOS,
  type GoldenExpected,
  isNegativeGoldenExpected,
  POSITIONS_MOVEMENTS_GOLDEN_FIXTURES,
  parseGoldenExpected,
} from "./manifest";
import {
  localExtractorGoldenRoot,
  resolveBalanceSeriesExpectedPath,
  resolveFixtureExpectedPath,
  resolveFixtureImagePath,
} from "./paths";
import { MIN_SYNTHETIC_CAPTURE_BYTES, syntheticFixtureSpec } from "./synthetic-fixtures";

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** PNG width and height live in the IHDR chunk, right after the 8-byte signature. */
function readPngSize(bytes: Buffer): { height: number; width: number } {
  return { height: bytes.readUInt32BE(20), width: bytes.readUInt32BE(16) };
}

const POSITIVE_EXPECTED = {
  positions: [
    {
      currency: "EUR",
      marketValueEur: 13450.32,
      name: "Vanguard FTSE All-World",
      ticker: "VWCE",
      units: 120,
    },
  ],
  warnings: [],
};

describe("extractor golden manifest", () => {
  it("covers every required scenario exactly once", () => {
    const scenarios = EXTRACTOR_GOLDEN_FIXTURES.map((fixture) => fixture.scenario);
    // Compare the full list, not a Set: a duplicated scenario must fail too.
    expect([...scenarios].sort()).toEqual([...EXTRACTOR_GOLDEN_SCENARIOS].sort());
  });

  it("keeps every fixture id unique across the three tracks", () => {
    const ids = [
      ...EXTRACTOR_GOLDEN_FIXTURES.map((fixture) => fixture.id),
      ...BALANCE_SERIES_GOLDEN_FIXTURES.map((fixture) => fixture.id),
      ...POSITIONS_MOVEMENTS_GOLDEN_FIXTURES.map((fixture) => fixture.id),
    ];
    // `decideAdmission` measures completeness with a Set of ids, so a duplicate would
    // make a run look complete with one fixture missing — and `--only` ambiguous.
    expect(ids.length).toBe(new Set(ids).size);
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

  it("ships every committed fixture and its expected file inside the repo", async () => {
    const committed = EXTRACTOR_GOLDEN_FIXTURES.filter(
      (candidate) => candidate.storage === "committed",
    );
    expect(committed.length).toBeGreaterThanOrEqual(3);
    for (const fixture of committed) {
      const image = await readFile(resolveFixtureImagePath(fixture));
      expect(image.subarray(0, PNG_MAGIC.length)).toEqual(PNG_MAGIC);
      const raw = await readFile(resolveFixtureExpectedPath(fixture), "utf8");
      expect(() => parseGoldenExpected(JSON.parse(raw))).not.toThrow();
    }
  });

  it("declares the payment screen and the amortization capture as negative cases", async () => {
    for (const id of ["synthetic-payment-screen", "synthetic-amortization-schedule"]) {
      const fixture = EXTRACTOR_GOLDEN_FIXTURES.find((candidate) => candidate.id === id);
      expect(fixture, `missing fixture ${id}`).toBeDefined();
      expect(fixture?.storage).toBe("committed");
      const raw = await readFile(resolveFixtureExpectedPath(fixture!), "utf8");
      const expected = parseGoldenExpected(JSON.parse(raw));
      expect(isNegativeGoldenExpected(expected)).toBe(true);
    }
  });

  // A negative case passes on `unrecognized`, which is exactly what the model answers
  // for a blank, 1×1 or truncated capture. Without this, a broken PNG would grade
  // green in a vacuum.
  it("pins every committed capture to the size and weight of its HTML source", async () => {
    for (const fixture of EXTRACTOR_GOLDEN_FIXTURES.filter(
      (candidate) => candidate.storage === "committed",
    )) {
      const spec = syntheticFixtureSpec(fixture.id);
      expect(spec, `no synthetic spec for ${fixture.id}`).toBeDefined();
      const image = await readFile(resolveFixtureImagePath(fixture));
      expect(readPngSize(image)).toEqual(spec?.capture);
      expect(image.byteLength).toBeGreaterThanOrEqual(MIN_SYNTHETIC_CAPTURE_BYTES);
    }
  });

  it("covers every balance-series scenario exactly once", () => {
    const scenarios = BALANCE_SERIES_GOLDEN_FIXTURES.map((fixture) => fixture.scenario);
    expect([...scenarios].sort()).toEqual([...BALANCE_SERIES_GOLDEN_SCENARIOS].sort());
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

describe("parseGoldenExpected", () => {
  it("parses the negative shape and tags it as negative", () => {
    const expected = parseGoldenExpected({ expect: "unrecognized" });
    expect(expected).toEqual({ expect: "unrecognized" });
    expect(isNegativeGoldenExpected(expected)).toBe(true);
  });

  it("still parses a positive expected and does not tag it as negative", () => {
    const expected = parseGoldenExpected(POSITIVE_EXPECTED);
    expect(isNegativeGoldenExpected(expected)).toBe(false);
    expect(expected).toMatchObject({ positions: POSITIVE_EXPECTED.positions });
  });

  it("accepts an explicit positive tag", () => {
    const expected = parseGoldenExpected({ ...POSITIVE_EXPECTED, expect: "positions" });
    expect(isNegativeGoldenExpected(expected)).toBe(false);
  });

  it("rejects a mixed expected that declares both shapes", () => {
    expect(() =>
      parseGoldenExpected({ ...POSITIVE_EXPECTED, expect: "unrecognized" }),
    ).toThrow();
  });

  it("rejects a positive expected with no positions instead of reading it as negative", () => {
    expect(() => parseGoldenExpected({ positions: [], warnings: [] })).toThrow();
    expect(() => parseGoldenExpected({ warnings: [] })).toThrow();
  });

  it("rejects an unknown expect tag", () => {
    expect(() => parseGoldenExpected({ expect: "whatever" })).toThrow();
  });
});

describe("isNegativeGoldenExpected", () => {
  it("narrows the union so positive expectations keep their positions", () => {
    const expected: GoldenExpected = parseGoldenExpected(POSITIVE_EXPECTED);
    if (isNegativeGoldenExpected(expected)) throw new Error("unreachable");
    expect(expected.positions).toHaveLength(1);
  });
});
