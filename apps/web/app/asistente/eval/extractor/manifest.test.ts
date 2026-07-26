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
  parseBalanceSeriesGoldenExpected,
  parseGoldenExpected,
} from "./manifest";
import {
  localExtractorGoldenRoot,
  resolveBalanceSeriesExpectedPath,
  resolveBalanceSeriesSourcePath,
  resolveFixtureExpectedPath,
  resolveFixtureImagePath,
} from "./paths";
import { MIN_SYNTHETIC_CAPTURE_BYTES, syntheticFixtureSpec } from "./synthetic-fixtures";

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** PNG width and height live in the IHDR chunk, right after the 8-byte signature. */
function readPngSize(bytes: Buffer): { height: number; width: number } {
  return { height: bytes.readUInt32BE(20), width: bytes.readUInt32BE(16) };
}

/**
 * Every capture git ships, across tracks. Since #1243 the committed set spans the
 * positions track and the balance-series one, and the size/weight tripwire has to
 * follow the captures — not the track they happen to be graded on.
 */
const COMMITTED_CAPTURES = [
  ...EXTRACTOR_GOLDEN_FIXTURES.filter((fixture) => fixture.storage === "committed").map(
    (fixture) => ({
      expectedPath: resolveFixtureExpectedPath(fixture),
      id: fixture.id,
      imagePath: resolveFixtureImagePath(fixture),
      // Each track validates its expected with its OWN parser: unifying the two
      // tracks into one list must not cost the cheap CI coverage that catches a typo
      // in a committed expected file before anyone spends model quota on it.
      parseExpected: parseGoldenExpected,
    }),
  ),
  ...BALANCE_SERIES_GOLDEN_FIXTURES.filter(
    (fixture) => fixture.storage === "committed",
  ).map((fixture) => ({
    expectedPath: resolveBalanceSeriesExpectedPath(fixture),
    id: fixture.id,
    imagePath: resolveBalanceSeriesSourcePath(fixture),
    parseExpected: parseBalanceSeriesGoldenExpected,
  })),
];

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

  it("ships every committed capture and parses its expected file with its own track's parser", async () => {
    expect(COMMITTED_CAPTURES.length).toBeGreaterThanOrEqual(3);
    for (const capture of COMMITTED_CAPTURES) {
      const image = await readFile(capture.imagePath);
      expect(image.subarray(0, PNG_MAGIC.length), capture.id).toEqual(PNG_MAGIC);
      expect(capture.expectedPath).not.toMatch(localExtractorGoldenRoot());
      const raw = await readFile(capture.expectedPath, "utf8");
      expect(() => capture.parseExpected(JSON.parse(raw)), capture.id).not.toThrow();
    }
  });

  it("declares the payment screen as a negative case", async () => {
    const fixture = EXTRACTOR_GOLDEN_FIXTURES.find(
      (candidate) => candidate.id === "synthetic-payment-screen",
    );
    expect(fixture).toBeDefined();
    expect(fixture?.storage).toBe("committed");
    const raw = await readFile(resolveFixtureExpectedPath(fixture!), "utf8");
    expect(isNegativeGoldenExpected(parseGoldenExpected(JSON.parse(raw)))).toBe(true);
  });

  /**
   * #1243's easy way out was to leave the amortization capture as a negative case once
   * the unified seam started identifying it. This pins the honest outcome instead: the
   * capture grades a real dated balance series, with the balances that are legible in
   * the image — so "does not hallucinate" can never quietly replace "reads it right".
   */
  it("grades the amortization capture as a real balance series, not as a negative case", async () => {
    expect(
      EXTRACTOR_GOLDEN_FIXTURES.some(
        (fixture) => fixture.id === "synthetic-amortization-schedule",
      ),
    ).toBe(false);
    const fixture = BALANCE_SERIES_GOLDEN_FIXTURES.find(
      (candidate) => candidate.id === "synthetic-amortization-schedule",
    );
    expect(fixture).toBeDefined();
    expect(fixture?.storage).toBe("committed");

    const raw = await readFile(resolveBalanceSeriesExpectedPath(fixture!), "utf8");
    const parsed: unknown = JSON.parse(raw);
    const expected = parseBalanceSeriesGoldenExpected(parsed);
    expect(expected.balances).toHaveLength(6);
    expect(expected.balances[0]).toEqual({
      amount: 11729.52,
      currency: "EUR",
      date: "2026-02-05",
    });
    expect(expected.balances.at(-1)?.amount).toBe(10362.84);
    // The negative shape is a different, closed schema: it must not parse here.
    expect(() => parseGoldenExpected(parsed)).toThrow();
  });

  // A negative case passes on `unrecognized`, which is exactly what the model answers
  // for a blank, 1×1 or truncated capture. Without this, a broken PNG would grade
  // green in a vacuum.
  it("pins every committed capture to the size and weight of its HTML source", async () => {
    for (const capture of COMMITTED_CAPTURES) {
      const spec = syntheticFixtureSpec(capture.id);
      expect(spec, `no synthetic spec for ${capture.id}`).toBeDefined();
      const image = await readFile(capture.imagePath);
      expect(readPngSize(image), capture.id).toEqual(spec?.capture);
      expect(image.byteLength).toBeGreaterThanOrEqual(MIN_SYNTHETIC_CAPTURE_BYTES);
    }
  });

  it("covers every balance-series scenario exactly once", () => {
    const scenarios = BALANCE_SERIES_GOLDEN_FIXTURES.map((fixture) => fixture.scenario);
    expect([...scenarios].sort()).toEqual([...BALANCE_SERIES_GOLDEN_SCENARIOS].sort());
  });

  it("keeps every real bank document private under .local", () => {
    for (const fixture of BALANCE_SERIES_GOLDEN_FIXTURES.filter(
      (candidate) => candidate.storage === "local",
    )) {
      expect(resolveBalanceSeriesExpectedPath(fixture)).toMatch(
        new RegExp(`${localExtractorGoldenRoot().replaceAll("/", "\\/")}/`),
      );
    }
    // Only synthetic renders may be committed: a real PDF statement never is.
    for (const fixture of BALANCE_SERIES_GOLDEN_FIXTURES.filter(
      (candidate) => candidate.storage === "committed",
    )) {
      expect(fixture.sourceFile).toMatch(/^fixtures\/synthetic-/);
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
