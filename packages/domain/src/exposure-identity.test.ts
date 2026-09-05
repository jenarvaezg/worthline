import { describe, expect, test } from "vitest";

import {
  deriveExposureCatalogIdentity,
  exposureLookthroughKey,
  exposureProfileLookthroughMap,
  globalExposureProfileIdentityKey,
  resolveGlobalExposureProfileIdentity,
} from "./exposure-identity";
import type { GlobalExposureProfile } from "./global-exposure-profile";

// Real, checksum-valid ISINs reused from the catalog persistence fixtures.
const VWRL_ISIN = "IE00B3RBWM25";

describe("exposureLookthroughKey", () => {
  test("typed identity chooses exactly one namespace and never falls back from a malformed declaration", () => {
    expect(
      exposureLookthroughKey({
        securityId: { kind: "isin", value: VWRL_ISIN },
        providerSymbol: "VWCE",
      }),
    ).toBe(VWRL_ISIN);
    expect(
      exposureLookthroughKey({
        securityId: { kind: "dgs", value: "n-5394" },
        providerSymbol: "N5394-Myinvestor",
      }),
    ).toBe("dgs:N5394");
    expect(
      exposureLookthroughKey({
        securityId: null,
        isin: VWRL_ISIN,
        providerSymbol: " VWCE ",
      }),
    ).toBe("VWCE");
    expect(exposureLookthroughKey({ securityId: null, isin: VWRL_ISIN })).toBeNull();
    for (const securityId of [
      { kind: "isin", value: "N5394" },
      { kind: "dgs", value: "" },
      { kind: "dgs", value: "F2244" },
    ] as const) {
      expect(
        exposureLookthroughKey({ securityId, isin: VWRL_ISIN, providerSymbol: "VWCE" }),
      ).toBeNull();
    }
  });

  test("prefers the ISIN over the provider symbol", () => {
    expect(exposureLookthroughKey({ isin: "IE00B4L5Y983", providerSymbol: "VWCE" })).toBe(
      "IE00B4L5Y983",
    );
  });

  test("falls back to the raw provider symbol when there is no ISIN", () => {
    expect(exposureLookthroughKey({ providerSymbol: "bitcoin" })).toBe("bitcoin");
  });

  test("yields null when neither field is present", () => {
    expect(exposureLookthroughKey({})).toBeNull();
  });

  test("a non-ISIN in the isin column falls back to the provider symbol (#1453)", () => {
    // The real case: a pension plan's DGS code stored in the isin column. The
    // registration identity already fell back to the symbol; the look-through
    // key must fall the same way or the profile is stored under one key and
    // looked up under another.
    expect(
      exposureLookthroughKey({ isin: "N5394", providerSymbol: "N5394-Myinvestor" }),
    ).toBe("N5394-Myinvestor");
  });

  test("normalises a valid ISIN (trim + upper-case) like the registration identity", () => {
    expect(exposureLookthroughKey({ isin: `  ${VWRL_ISIN.toLowerCase()}  ` })).toBe(
      VWRL_ISIN,
    );
  });

  test("a non-ISIN with no symbol yields null, never a garbage key", () => {
    expect(exposureLookthroughKey({ isin: "N5394" })).toBeNull();
  });

  test("blank fields are absent (an empty-string isin falls through)", () => {
    expect(exposureLookthroughKey({ isin: "", providerSymbol: "VWCE" })).toBe("VWCE");
    expect(exposureLookthroughKey({ isin: "   ", providerSymbol: "  " })).toBeNull();
  });

  test("keys under the exact key the catalog registered when the ISIN is invalid (#1453)", () => {
    // Registration side: the DGS code fails validation, the row registers under
    // the provider identity. Reading side: the same holding must produce the key
    // that identity maps to — the two rules are one rule again.
    const identity = deriveExposureCatalogIdentity({
      instrument: "pension_plan",
      isin: "N5394",
      providerSymbol: "N5394-Myinvestor",
    });
    expect(identity).toEqual({
      kind: "provider",
      priceProvider: "finect",
      providerSymbol: "N5394-Myinvestor",
    });

    const map = exposureProfileLookthroughMap([
      profile({ identity: identity!, breakdowns: { assetClass: { equity: "1" } } }),
    ]);
    const holdingKey = exposureLookthroughKey({
      isin: "N5394",
      providerSymbol: "N5394-Myinvestor",
    });
    expect(holdingKey).not.toBeNull();
    expect(map.has(holdingKey!)).toBe(true);
  });
});

describe("deriveExposureCatalogIdentity", () => {
  test("a typed pension plan registers and resolves the same DGS profile, independent of its price slug", () => {
    const source = {
      instrument: "pension_plan",
      securityId: { kind: "dgs", value: "n-5394" },
      isin: VWRL_ISIN,
      providerSymbol: "N5394-Myinvestor",
    } as const;
    const identity = deriveExposureCatalogIdentity(source);
    expect(identity).toEqual({ kind: "dgs", code: "N5394" });
    expect(resolveGlobalExposureProfileIdentity(source)).toEqual(identity);
    expect(globalExposureProfileIdentityKey(identity!)).toBe("dgs:N5394");
    const map = exposureProfileLookthroughMap([profile({ identity: identity! })]);
    expect(map.has(exposureLookthroughKey(source)!)).toBe(true);
    expect(map.has("N5394-Myinvestor")).toBe(false);
  });

  test("typed absence ignores legacy ISIN and a malformed typed declaration never registers by symbol", () => {
    const source = {
      instrument: "pension_plan",
      isin: VWRL_ISIN,
      providerSymbol: "plan",
      priceProvider: "finect",
    } as const;
    const providerIdentity = {
      kind: "provider",
      priceProvider: "finect",
      providerSymbol: "plan",
    };
    expect(deriveExposureCatalogIdentity({ ...source, securityId: null })).toEqual(
      providerIdentity,
    );
    expect(resolveGlobalExposureProfileIdentity({ ...source, securityId: null })).toEqual(
      providerIdentity,
    );
    for (const securityId of [
      { kind: "dgs", value: "F2244" },
      { kind: "dgs", value: "" },
      { kind: "isin", value: "N5394" },
    ] as const) {
      expect(deriveExposureCatalogIdentity({ ...source, securityId })).toBeNull();
      expect(() =>
        resolveGlobalExposureProfileIdentity({ ...source, securityId }),
      ).toThrow();
    }
    expect(
      deriveExposureCatalogIdentity({
        instrument: "crypto",
        securityId: { kind: "dgs", value: "N5394" },
      }),
    ).toBeNull();
  });

  test("a market fund with a valid ISIN → isin identity", () => {
    expect(
      deriveExposureCatalogIdentity({ instrument: "fund", isin: VWRL_ISIN }),
    ).toEqual({
      isin: VWRL_ISIN,
      kind: "isin",
    });
  });

  test("normalises the ISIN (trims + upper-cases before validating)", () => {
    expect(
      deriveExposureCatalogIdentity({
        instrument: "etf",
        isin: `  ${VWRL_ISIN.toLowerCase()}  `,
      }),
    ).toEqual({ isin: VWRL_ISIN, kind: "isin" });
  });

  test("no ISIN → provider identity from the instrument's default provider", () => {
    expect(
      deriveExposureCatalogIdentity({ instrument: "fund", providerSymbol: "0P0000ABC" }),
    ).toEqual({ kind: "provider", priceProvider: "yahoo", providerSymbol: "0P0000ABC" });
  });

  test("a pension plan defaults to the finect provider", () => {
    expect(
      deriveExposureCatalogIdentity({
        instrument: "pension_plan",
        providerSymbol: "FI123",
      }),
    ).toEqual({ kind: "provider", priceProvider: "finect", providerSymbol: "FI123" });
  });

  test("an invalid ISIN falls back to the provider identity when a symbol exists", () => {
    expect(
      deriveExposureCatalogIdentity({
        instrument: "stock",
        isin: "NOTANISIN",
        providerSymbol: "AAPL",
      }),
    ).toEqual({ kind: "provider", priceProvider: "yahoo", providerSymbol: "AAPL" });
  });

  test("an explicit valid priceProvider wins over the instrument default", () => {
    expect(
      deriveExposureCatalogIdentity({
        instrument: "stock",
        providerSymbol: "REP.MC",
        priceProvider: "stooq",
      }),
    ).toEqual({ kind: "provider", priceProvider: "stooq", providerSymbol: "REP.MC" });
  });

  test("an unknown explicit priceProvider is ignored in favour of the default", () => {
    expect(
      deriveExposureCatalogIdentity({
        instrument: "etf",
        providerSymbol: "SPY",
        priceProvider: "made-up",
      }),
    ).toEqual({ kind: "provider", priceProvider: "yahoo", providerSymbol: "SPY" });
  });

  test("a non-market instrument never registers, even with a valid ISIN", () => {
    expect(
      deriveExposureCatalogIdentity({ instrument: "property", isin: VWRL_ISIN }),
    ).toBeNull();
  });

  test("crypto is not a look-through profile instrument → null", () => {
    expect(
      deriveExposureCatalogIdentity({ instrument: "crypto", providerSymbol: "BTC" }),
    ).toBeNull();
  });

  test("a market instrument with neither ISIN nor symbol → null", () => {
    expect(deriveExposureCatalogIdentity({ instrument: "fund" })).toBeNull();
  });

  test("blank/null fields are treated as absent", () => {
    expect(
      deriveExposureCatalogIdentity({
        instrument: "fund",
        isin: "   ",
        providerSymbol: null,
      }),
    ).toBeNull();
  });

  describe("instrument omitted (caller vouches for a market investment)", () => {
    test("resolves an ISIN identity with no instrument", () => {
      expect(deriveExposureCatalogIdentity({ isin: VWRL_ISIN })).toEqual({
        isin: VWRL_ISIN,
        kind: "isin",
      });
    });

    test("resolves a provider identity from the explicit provider", () => {
      expect(
        deriveExposureCatalogIdentity({
          priceProvider: "finect",
          providerSymbol: "N5394",
        }),
      ).toEqual({ kind: "provider", priceProvider: "finect", providerSymbol: "N5394" });
    });

    test("a symbol with no explicit provider and no instrument cannot resolve → null", () => {
      expect(deriveExposureCatalogIdentity({ providerSymbol: "AAPL" })).toBeNull();
    });

    test("a coingecko-priced holding (crypto) never registers, even with no instrument", () => {
      // The backfill reads every investment asset — including crypto — without an
      // instrument. Crypto has no look-through, so its coingecko provider must
      // resolve to no identity.
      expect(
        deriveExposureCatalogIdentity({
          priceProvider: "coingecko",
          providerSymbol: "bitcoin",
        }),
      ).toBeNull();
    });
  });

  test("a crypto instrument never registers (coingecko is not a look-through provider)", () => {
    expect(
      deriveExposureCatalogIdentity({
        instrument: "crypto",
        priceProvider: "coingecko",
        providerSymbol: "bitcoin",
      }),
    ).toBeNull();
  });
});

function profile(overrides: Partial<GlobalExposureProfile>): GlobalExposureProfile {
  return {
    identity: { kind: "isin", isin: "IE00B4L5Y983" },
    displayName: null,
    breakdowns: {},
    ter: null,
    trackedIndex: null,
    hedgedToCurrency: null,
    confidence: null,
    asOfDate: null,
    sources: null,
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
