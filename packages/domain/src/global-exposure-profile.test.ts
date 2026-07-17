import { describe, expect, test } from "vitest";

import {
  createValidatedGlobalExposureProfileInput,
  globalExposureProfileIdentityKey,
  isValidIsin,
  resolveGlobalExposureProfileIdentity,
  validateGlobalExposureProfileContent,
} from "./global-exposure-profile";

const VWRL_ISIN = "IE00B3RBWM25";

describe("global exposure profile identity (#940)", () => {
  test("normalizes a valid ISIN to uppercase with checksum validation", () => {
    expect(resolveGlobalExposureProfileIdentity({ isin: " ie00b3rbwm25 " })).toEqual({
      kind: "isin",
      isin: VWRL_ISIN,
    });
    expect(isValidIsin(VWRL_ISIN)).toBe(true);
    expect(isValidIsin("IE00B3RBWM26")).toBe(false);
  });

  test("falls back to priceProvider + providerSymbol when the ISIN is invalid", () => {
    expect(
      resolveGlobalExposureProfileIdentity({
        isin: "not-an-isin",
        priceProvider: "yahoo",
        providerSymbol: " VWRL.L ",
      }),
    ).toEqual({
      kind: "provider",
      priceProvider: "yahoo",
      providerSymbol: "VWRL.L",
    });
  });

  test("preserves provider symbol case while trimming whitespace", () => {
    expect(
      resolveGlobalExposureProfileIdentity({
        priceProvider: "finect",
        providerSymbol: " N5394 ",
      }),
    ).toEqual({
      kind: "provider",
      priceProvider: "finect",
      providerSymbol: "N5394",
    });
  });

  test("serializes provider identities with a stable prefixed key", () => {
    expect(
      globalExposureProfileIdentityKey({
        kind: "provider",
        priceProvider: "yahoo",
        providerSymbol: "VWRL.L",
      }),
    ).toBe("p:yahoo:VWRL.L");
  });
});

describe("global exposure profile content validation (#940)", () => {
  test("accepts weights in [0,1] with each dimension summing to at most 1", () => {
    expect(
      validateGlobalExposureProfileContent({
        breakdowns: {
          geography: { us: "0.6", europe_developed: "0.15" },
          currency: { EUR: "0.4", USD: "0.3" },
          assetClass: { equity: "1" },
        },
        ter: "0.0022",
      }),
    ).toEqual({
      displayName: null,
      breakdowns: {
        geography: { us: "0.6", europe_developed: "0.15" },
        currency: { EUR: "0.4", USD: "0.3" },
        assetClass: { equity: "1" },
      },
      ter: "0.0022",
      trackedIndex: null,
      hedgedToCurrency: null,
    });
  });

  test("rejects weights outside [0,1] and dimension totals above 1", () => {
    expect(() =>
      validateGlobalExposureProfileContent({
        breakdowns: { geography: { us: "1.1" } },
      }),
    ).toThrow(/between 0 and 1/);
    expect(() =>
      validateGlobalExposureProfileContent({
        breakdowns: { assetClass: { equity: "0.6", bond: "0.5" } },
      }),
    ).toThrow(/cannot exceed 100%/);
  });

  test("rejects mixed asset class and invalid currency buckets", () => {
    expect(() =>
      validateGlobalExposureProfileContent({
        breakdowns: { assetClass: { mixed: "1" } as never },
      }),
    ).toThrow(/not allowed/);
    expect(() =>
      validateGlobalExposureProfileContent({
        breakdowns: { currency: { EURO: "1" } },
      }),
    ).toThrow(/ISO-4217 uppercase/);
  });

  test("normalizes empty strings to null and rejects a fully empty profile", () => {
    expect(() =>
      validateGlobalExposureProfileContent({
        displayName: "  ",
        trackedIndex: "",
        hedgedToCurrency: " ",
        ter: "",
        breakdowns: {},
      }),
    ).toThrow(/completely empty/);

    expect(
      validateGlobalExposureProfileContent({
        displayName: " Vanguard FTSE All-World ",
        ter: " ",
        breakdowns: { assetClass: { equity: "1" } },
      }),
    ).toMatchObject({
      displayName: "Vanguard FTSE All-World",
      ter: null,
    });

    expect(
      validateGlobalExposureProfileContent({
        breakdowns: { currency: { eur: "1" } },
      }).breakdowns.currency,
    ).toEqual({ EUR: "1" });
  });

  test("accepts a sector vector (% of equity) summing to at most 1 (ADR 0065, S4)", () => {
    expect(
      validateGlobalExposureProfileContent({
        breakdowns: {
          assetClass: { equity: "1" },
          sector: {
            information_technology: "0.3",
            financials: "0.2",
            health_care: "0.15",
          },
        },
      }).breakdowns.sector,
    ).toEqual({
      information_technology: "0.3",
      financials: "0.2",
      health_care: "0.15",
    });
  });

  test("rejects an unknown sector bucket and a sector total above 1", () => {
    expect(() =>
      validateGlobalExposureProfileContent({
        breakdowns: { sector: { tech: "1" } as never },
      }),
    ).toThrow(/not allowed/);
    expect(() =>
      validateGlobalExposureProfileContent({
        breakdowns: { sector: { financials: "0.7", utilities: "0.5" } },
      }),
    ).toThrow(/cannot exceed 100%/);
  });

  test("a sector-only vector is enough content — not a fully empty profile", () => {
    expect(
      validateGlobalExposureProfileContent({
        breakdowns: { sector: { energy: "1" } },
      }).breakdowns.sector,
    ).toEqual({ energy: "1" });
  });

  test("rejects TER outside [0,1]", () => {
    expect(() =>
      validateGlobalExposureProfileContent({
        ter: "1.01",
        breakdowns: { assetClass: { equity: "1" } },
      }),
    ).toThrow(/TER must be between 0 and 1/);
  });

  test("createValidatedGlobalExposureProfileInput composes identity and content", () => {
    expect(
      createValidatedGlobalExposureProfileInput({
        identity: { isin: VWRL_ISIN },
        trackedIndex: "FTSE All-World",
        breakdowns: { assetClass: { equity: "1" } },
      }),
    ).toEqual({
      identity: { kind: "isin", isin: VWRL_ISIN },
      displayName: null,
      trackedIndex: "FTSE All-World",
      ter: null,
      hedgedToCurrency: null,
      breakdowns: { assetClass: { equity: "1" } },
    });
  });
});
