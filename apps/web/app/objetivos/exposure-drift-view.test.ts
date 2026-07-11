import { describe, expect, test } from "vitest";

import { parseExposureDriftGrowth, parseExposureDriftYear } from "./exposure-drift-view";

describe("parseExposureDriftGrowth", () => {
  test("defaults to historical", () => {
    expect(parseExposureDriftGrowth(undefined)).toBe("historical");
    expect(parseExposureDriftGrowth("historical")).toBe("historical");
  });

  test("accepts flat", () => {
    expect(parseExposureDriftGrowth("flat")).toBe("flat");
  });
});

describe("parseExposureDriftYear", () => {
  const trajectory = [
    {
      year: 0,
      grossAssets: { amountMinor: 1, currency: "EUR" },
      geography: {
        slices: [],
        coverage: {
          classified: { amountMinor: 0, currency: "EUR" },
          notApplicable: { amountMinor: 0, currency: "EUR" },
          unknown: { amountMinor: 0, currency: "EUR" },
        },
      },
      assetClass: {
        slices: [],
        coverage: {
          classified: { amountMinor: 0, currency: "EUR" },
          notApplicable: { amountMinor: 0, currency: "EUR" },
          unknown: { amountMinor: 0, currency: "EUR" },
        },
      },
    },
    {
      year: 5,
      grossAssets: { amountMinor: 2, currency: "EUR" },
      geography: {
        slices: [],
        coverage: {
          classified: { amountMinor: 0, currency: "EUR" },
          notApplicable: { amountMinor: 0, currency: "EUR" },
          unknown: { amountMinor: 0, currency: "EUR" },
        },
      },
      assetClass: {
        slices: [],
        coverage: {
          classified: { amountMinor: 0, currency: "EUR" },
          notApplicable: { amountMinor: 0, currency: "EUR" },
          unknown: { amountMinor: 0, currency: "EUR" },
        },
      },
    },
  ];

  test("defaults to the last trajectory year", () => {
    expect(parseExposureDriftYear(undefined, trajectory)).toBe(5);
  });

  test("snaps to the closest available year", () => {
    expect(parseExposureDriftYear("4", trajectory)).toBe(5);
    expect(parseExposureDriftYear("0", trajectory)).toBe(0);
  });
});
