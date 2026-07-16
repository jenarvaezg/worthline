import { describe, expect, test } from "vitest";

import { deriveExposureCatalogIdentity } from "./exposure-catalog-identity";

// Real, checksum-valid ISINs reused from the catalog persistence fixtures.
const VWRL_ISIN = "IE00B3RBWM25";

describe("deriveExposureCatalogIdentity", () => {
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
