import { describe, expect, test } from "vitest";

import { exposureProfileLookthroughMap } from "./exposure-catalog-lookthrough";
import type { GlobalExposureProfile } from "./global-exposure-profile";

function profile(overrides: Partial<GlobalExposureProfile>): GlobalExposureProfile {
  return {
    identity: { kind: "isin", isin: "IE00B4L5Y983" },
    displayName: null,
    breakdowns: {},
    ter: null,
    trackedIndex: null,
    hedgedToCurrency: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("exposureProfileLookthroughMap (#711 S3)", () => {
  test("keys an ISIN-identity profile by its ISIN, matching holding resolution", () => {
    const map = exposureProfileLookthroughMap([
      profile({
        identity: { kind: "isin", isin: "IE00B4L5Y983" },
        trackedIndex: "MSCI World",
        ter: "0.002",
        breakdowns: { assetClass: { equity: "1" } },
      }),
    ]);

    expect([...map.keys()]).toEqual(["IE00B4L5Y983"]);
    expect(map.get("IE00B4L5Y983")).toEqual({
      key: "IE00B4L5Y983",
      source: "user",
      declaredAt: null,
      trackedIndex: "MSCI World",
      ter: "0.002",
      hedged: false,
      breakdowns: { assetClass: { equity: "1" } },
    });
  });

  test("keys a provider-identity profile by its raw providerSymbol (not the p: composite)", () => {
    const map = exposureProfileLookthroughMap([
      profile({
        identity: {
          kind: "provider",
          priceProvider: "coingecko",
          providerSymbol: "bitcoin",
        },
        breakdowns: { assetClass: { crypto: "1" } },
      }),
    ]);

    expect([...map.keys()]).toEqual(["bitcoin"]);
    expect(map.get("bitcoin")?.breakdowns).toEqual({ assetClass: { crypto: "1" } });
  });

  test("carries the sector vector through to look-through unchanged (S4 → S2 seam)", () => {
    const map = exposureProfileLookthroughMap([
      profile({
        breakdowns: {
          assetClass: { equity: "1" },
          sector: { information_technology: "0.3", health_care: "0.2" },
        },
      }),
    ]);

    expect(map.get("IE00B4L5Y983")?.breakdowns.sector).toEqual({
      information_technology: "0.3",
      health_care: "0.2",
    });
  });

  test("maps a hedgedToCurrency value to hedged:true (currency-risk suppression)", () => {
    const map = exposureProfileLookthroughMap([profile({ hedgedToCurrency: "EUR" })]);

    expect(map.get("IE00B4L5Y983")?.hedged).toBe(true);
  });

  test("empty catalog yields an empty map", () => {
    expect(exposureProfileLookthroughMap([]).size).toBe(0);
  });
});
