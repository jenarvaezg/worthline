/**
 * Unit tests for the pure exposure-profile form module (PRD #539 S1, #541).
 *
 * All the among-fields logic lives here (interaction-patterns §7): the field →
 * `ExposureProfile` parse (percents → decimal-string fractions, TER percent →
 * fraction, asset class → `{[class]:"1"}`), the geography `Otros` remainder, and
 * the >100% rejection surfaced as a Spanish message. No React, no DB.
 */

import { describe, expect, test } from "vitest";

import {
  buildExposureProfileResult,
  geographyRemainderPercent,
  isEmptyExposureFields,
  parseExposureProfileFields,
  type ExposureProfileFields,
} from "./exposure-profile-form";

/** A blank field map (every input empty) — the "clear" submission. */
function emptyFields(): ExposureProfileFields {
  return {
    geography: {
      us: "",
      europe_developed: "",
      japan: "",
      pacific_developed: "",
      emerging: "",
      other: "",
    },
    assetClass: "",
    ter: "",
    trackedIndex: "",
    hedged: false,
  };
}

describe("parseExposureProfileFields", () => {
  test("geography percents become decimal-string fractions", () => {
    const fields: ExposureProfileFields = {
      ...emptyFields(),
      geography: {
        ...emptyFields().geography,
        us: "60",
        europe_developed: "25",
        emerging: "15",
      },
    };

    const profile = parseExposureProfileFields("IE00B4L5Y983", fields);

    expect(profile.key).toBe("IE00B4L5Y983");
    expect(profile.breakdowns.geography).toEqual({
      us: "0.6",
      europe_developed: "0.25",
      emerging: "0.15",
    });
  });

  test("blank geography buckets are omitted, never stored as zero", () => {
    const fields: ExposureProfileFields = {
      ...emptyFields(),
      geography: { ...emptyFields().geography, us: "100" },
    };

    const profile = parseExposureProfileFields("K", fields);

    expect(profile.breakdowns.geography).toEqual({ us: "1" });
    expect(profile.breakdowns.geography).not.toHaveProperty("japan");
  });

  test("asset class becomes a single-bucket vector { [class]: '1' }", () => {
    const profile = parseExposureProfileFields("K", {
      ...emptyFields(),
      assetClass: "equity",
    });

    expect(profile.breakdowns.assetClass).toEqual({ equity: "1" });
  });

  test("TER percent becomes a decimal-string fraction (0.22% → 0.0022)", () => {
    const profile = parseExposureProfileFields("K", { ...emptyFields(), ter: "0,22" });

    expect(profile.ter).toBe("0.0022");
  });

  test("tracked index and hedged carry through", () => {
    const profile = parseExposureProfileFields("K", {
      ...emptyFields(),
      trackedIndex: "MSCI World",
      hedged: true,
    });

    expect(profile.trackedIndex).toBe("MSCI World");
    expect(profile.hedged).toBe(true);
  });

  test("no asset class selected leaves the assetClass breakdown out", () => {
    const profile = parseExposureProfileFields("K", { ...emptyFields(), assetClass: "" });

    expect(profile.breakdowns.assetClass).toBeUndefined();
  });
});

describe("geographyRemainderPercent", () => {
  test("100 − Σ of the entered buckets", () => {
    expect(
      geographyRemainderPercent({
        ...emptyFields().geography,
        us: "60",
        europe_developed: "25",
      }),
    ).toBe(15);
  });

  test("full 100 leaves no remainder", () => {
    expect(geographyRemainderPercent({ ...emptyFields().geography, us: "100" })).toBe(0);
  });

  test("empty vector leaves the whole 100 undeclared", () => {
    expect(geographyRemainderPercent(emptyFields().geography)).toBe(100);
  });

  test("over-100 reports a negative remainder (the form surfaces the block)", () => {
    expect(
      geographyRemainderPercent({ ...emptyFields().geography, us: "80", emerging: "40" }),
    ).toBe(-20);
  });

  test("es-ES decimals parse the same as the save path (no display/save drift)", () => {
    const geography = { ...emptyFields().geography, us: "33,33", emerging: "10" };

    // The remainder must equal 100 − Σ using the SAME parser the save path uses:
    // parseExposureProfileFields → { us: "0.3333", emerging: "0.1" } ⇒ 56.67% left.
    expect(geographyRemainderPercent(geography)).toBeCloseTo(56.67, 6);
    expect(
      parseExposureProfileFields("K", { ...emptyFields(), geography }).breakdowns
        .geography,
    ).toEqual({ us: "0.3333", emerging: "0.1" });
  });
});

describe("isEmptyExposureFields", () => {
  test("all-blank is empty (→ delete)", () => {
    expect(isEmptyExposureFields(emptyFields())).toBe(true);
  });

  test("any single value makes it non-empty", () => {
    expect(isEmptyExposureFields({ ...emptyFields(), hedged: true })).toBe(false);
    expect(isEmptyExposureFields({ ...emptyFields(), trackedIndex: "X" })).toBe(false);
    expect(
      isEmptyExposureFields({
        ...emptyFields(),
        geography: { ...emptyFields().geography, us: "1" },
      }),
    ).toBe(false);
  });
});

describe("buildExposureProfileResult", () => {
  test("accepts a sub-100 geography vector", () => {
    const result = buildExposureProfileResult("K", {
      ...emptyFields(),
      geography: { ...emptyFields().geography, us: "60", emerging: "15" },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.profile.breakdowns.geography).toEqual({
        us: "0.6",
        emerging: "0.15",
      });
    }
  });

  test("rejects a geography vector over 100% with a Spanish message", () => {
    const result = buildExposureProfileResult("K", {
      ...emptyFields(),
      geography: { ...emptyFields().geography, us: "80", emerging: "40" },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/100/);
      expect(result.error).toMatch(/geogr[áa]f/i);
    }
  });
});
