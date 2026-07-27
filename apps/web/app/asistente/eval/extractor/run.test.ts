import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  type AdmissionQuestionResult,
  buildAdmissionReport,
} from "@web/asistente/eval/admission";
import { afterEach, describe, expect, it } from "vitest";

import { parseExtractorEvalArgs } from "./args";
import type { GoldenFixture } from "./manifest";
import { extractorEvalRoot } from "./paths";
import {
  assertKnownFixtureIds,
  runExtractorFixture,
  selectedBalanceSeriesFixtures,
  selectedFixtures,
} from "./run";

describe("parseExtractorEvalArgs", () => {
  it("defaults to a strict threshold and accepts model overrides", () => {
    expect(parseExtractorEvalArgs([])).toEqual({ threshold: 1 });
    expect(
      parseExtractorEvalArgs([
        "--model",
        "gemini-3.5-flash",
        "--threshold",
        "0.9",
        "--output",
        "/tmp/report.json",
        "--only",
        "synthetic-baseline",
        "mobile",
      ]),
    ).toEqual({
      model: "gemini-3.5-flash",
      only: ["synthetic-baseline", "mobile"],
      output: "/tmp/report.json",
      threshold: 0.9,
    });
  });

  it("rejects invalid thresholds", () => {
    expect(() => parseExtractorEvalArgs(["--threshold", "2"])).toThrow(
      "--threshold must be a number between 0 and 1.",
    );
  });
});

describe("selectedFixtures", () => {
  it("runs the committed synthetic captures by default", () => {
    const ids = selectedFixtures().map((fixture) => fixture.id);
    expect(ids).toContain("synthetic-baseline");
    expect(ids).toContain("synthetic-payment-screen");
    // Re-pointed by #1243: the amortization capture is graded on the balance-series
    // track now, so the committed subset must still reach it through that selector.
    expect(ids).not.toContain("synthetic-amortization-schedule");
    expect(
      selectedBalanceSeriesFixtures(["synthetic-amortization-schedule"]).map(
        (fixture) => fixture.id,
      ),
    ).toEqual(["synthetic-amortization-schedule"]);
  });

  it("narrows to the requested ids", () => {
    expect(selectedFixtures(["synthetic-payment-screen"]).map((f) => f.id)).toEqual([
      "synthetic-payment-screen",
    ]);
  });

  it("treats an empty --only list as no filter", () => {
    expect(selectedFixtures([]).length).toBe(selectedFixtures().length);
  });
});

describe("assertKnownFixtureIds", () => {
  it("accepts the committed negative fixture ids", () => {
    expect(() =>
      assertKnownFixtureIds([
        "synthetic-payment-screen",
        "synthetic-amortization-schedule",
      ]),
    ).not.toThrow();
  });

  it("rejects a typo", () => {
    expect(() => assertKnownFixtureIds(["synthetic-payment-scren"])).toThrow(
      "Unknown fixture id(s)",
    );
  });
});

// A broken expected file must not silently vanish from the ratio: the malformed JSON
// is caught before any model call, so this covers the `catch` without a network round
// trip.
const MALFORMED_EXPECTED_FILE = "expected/__malformed-expected.tmp.json";
const malformedExpectedPath = join(extractorEvalRoot(), MALFORMED_EXPECTED_FILE);

const malformedFixture: GoldenFixture = {
  expectedFile: MALFORMED_EXPECTED_FILE,
  id: "synthetic-payment-screen",
  imageFile: "fixtures/synthetic-payment-screen.png",
  scenario: "payment-screen",
  storage: "committed",
};

const reportFor = (results: readonly AdmissionQuestionResult[]) =>
  buildAdmissionReport({
    expectedQuestionIds: results.map((result) => result.id),
    finishedAt: "2026-07-26T00:00:01.000Z",
    model: "gemini-3.1-flash-lite",
    provider: "google",
    questionResults: results,
    startedAt: "2026-07-26T00:00:00.000Z",
    threshold: 1,
  });

const passingBaseline: AdmissionQuestionResult = {
  checks: Array.from({ length: 5 }, (_unused, index) => ({
    name: `check ${index}`,
    pass: true,
  })),
  dimension: "extraction",
  id: "synthetic-baseline",
  persona: "desktop",
  status: "completed",
};

describe("runExtractorFixture", () => {
  afterEach(async () => {
    await rm(malformedExpectedPath, { force: true });
  });

  it("reports a malformed expected file as a failing check, not as zero checks", async () => {
    await writeFile(malformedExpectedPath, '{ "expect": "unrecognised" }', "utf8");

    const result = await runExtractorFixture(malformedFixture, {});

    expect(result.status).toBe("error");
    expect(result.checks).toHaveLength(1);
    expect(result.checks[0]!.pass).toBe(false);
    expect(result.checks[0]!.name).toContain("error");
    expect(result.error).toBeDefined();
  });

  it("drags the whole run below the threshold when a fixture errors", async () => {
    await writeFile(malformedExpectedPath, "not even json", "utf8");

    const result = await runExtractorFixture(malformedFixture, {});
    const report = reportFor([
      passingBaseline,
      {
        checks: result.checks,
        dimension: "extraction",
        error: result.error ?? "",
        id: result.id,
        persona: result.scenario,
        status: "error",
      },
    ]);

    expect(report.summary.admitted).toBe(false);
  });

  it("documents the hole this guards: an error contributing no checks was ADMITTED", () => {
    const report = reportFor([
      passingBaseline,
      {
        checks: [],
        dimension: "extraction",
        error: "boom",
        id: "synthetic-payment-screen",
        persona: "payment-screen",
        status: "error",
      },
    ]);

    expect(report.summary.admitted).toBe(true);
  });
});
