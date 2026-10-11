import { describe, expect, test } from "vitest";

import type { ExposureProfile } from "./exposure-lookthrough";
import { type PortfolioCostHolding, portfolioCost } from "./portfolio-cost";

/**
 * The portfolio-cost lens (#1717): Σ value × TER and the value-weighted mean TER
 * over the part of gross whose TER is declared, with the look-through's coverage
 * honesty — an undeclared TER is a gap, never a 0.
 */

const EUR = "EUR";

function profile(key: string, ter: string | null | undefined): ExposureProfile {
  return {
    breakdowns: {},
    declaredAt: null,
    key,
    source: "user",
    ...(ter !== undefined ? { ter } : {}),
  };
}

function profilesOf(...entries: ExposureProfile[]): Map<string, ExposureProfile> {
  return new Map(entries.map((entry) => [entry.key, entry]));
}

function eur(amountMinor: number) {
  return { amountMinor, currency: EUR };
}

describe("portfolioCost", () => {
  test("weights each declared TER by value and prices the year in euros", () => {
    // 60.000 € at 0,22 % + 40.000 € at 0,12 % = 132 € + 48 € = 180 €/año, and
    // 180 € over the 100.000 € that carry a TER is a mean of 0,18 %.
    const holdings: PortfolioCostHolding[] = [
      {
        id: "world",
        instrument: "fund",
        securityId: { kind: "isin", value: "IE00B4L5Y983" },
        value: eur(60_000_00),
      },
      {
        id: "sp500",
        instrument: "etf",
        securityId: { kind: "isin", value: "IE00B5BMR087" },
        value: eur(40_000_00),
      },
    ];

    const cost = portfolioCost({
      grossAssets: eur(100_000_00),
      holdings,
      profiles: profilesOf(
        profile("IE00B4L5Y983", "0.0022"),
        profile("IE00B5BMR087", "0.0012"),
      ),
    });

    expect(cost.annualCost).toEqual(eur(180_00));
    expect(cost.weightedTer).toBe("0.0018");
    expect(cost.declaredShare).toBe("1");
    expect(cost.coverage).toEqual({
      classified: eur(100_000_00),
      notApplicable: eur(0),
      unknown: eur(0),
    });
  });

  test("an undeclared TER is a coverage gap, never a 0 that dilutes the mean", () => {
    // Only the 60.000 € fund declares a TER. Counting the other 40.000 € (a
    // profile with `ter: null` and a fund the catalog does not know) as 0 % would
    // print a mean of 0,132 %; the honest mean is 0,22 % over 60 % of gross.
    const holdings: PortfolioCostHolding[] = [
      {
        id: "world",
        instrument: "fund",
        securityId: { kind: "isin", value: "IE00B4L5Y983" },
        value: eur(60_000_00),
      },
      {
        id: "bonds",
        instrument: "fund",
        securityId: { kind: "isin", value: "IE00B3F81409" },
        value: eur(30_000_00),
      },
      {
        id: "uncatalogued",
        instrument: "etf",
        providerSymbol: "NOPE.DE",
        securityId: null,
        value: eur(10_000_00),
      },
    ];

    const cost = portfolioCost({
      grossAssets: eur(100_000_00),
      holdings,
      profiles: profilesOf(
        profile("IE00B4L5Y983", "0.0022"),
        profile("IE00B3F81409", null),
      ),
    });

    expect(cost.annualCost).toEqual(eur(132_00));
    expect(cost.weightedTer).toBe("0.0022");
    expect(cost.declaredShare).toBe("0.6");
    expect(cost.coverage).toEqual({
      classified: eur(60_000_00),
      notApplicable: eur(0),
      unknown: eur(40_000_00),
    });
  });

  test("what has no fund wrapper charges no TER: it is not applicable, not a gap", () => {
    // Cash, a house, crypto and a directly held share carry no ongoing charge,
    // so they neither dilute the mean nor read as a TER nobody declared.
    const holdings: PortfolioCostHolding[] = [
      {
        id: "world",
        instrument: "fund",
        securityId: { kind: "isin", value: "IE00B4L5Y983" },
        value: eur(50_000_00),
      },
      { id: "cash", instrument: "current_account", value: eur(20_000_00) },
      { id: "flat", instrument: "property", value: eur(15_000_00) },
      { id: "btc", instrument: "crypto", value: eur(5_000_00) },
      {
        id: "share",
        instrument: "stock",
        securityId: { kind: "isin", value: "US0378331005" },
        value: eur(10_000_00),
      },
    ];

    const cost = portfolioCost({
      grossAssets: eur(100_000_00),
      holdings,
      profiles: profilesOf(
        profile("IE00B4L5Y983", "0.002"),
        // A share's catalog row describes its sector and region, never a TER.
        profile("US0378331005", null),
      ),
    });

    expect(cost.annualCost).toEqual(eur(100_00));
    expect(cost.weightedTer).toBe("0.002");
    expect(cost.declaredShare).toBe("0.5");
    expect(cost.coverage).toEqual({
      classified: eur(50_000_00),
      notApplicable: eur(50_000_00),
      unknown: eur(0),
    });
  });

  test("a TER the catalog declares wins, whatever the instrument says", () => {
    // A holding typed `stock` that is really a fund wrapper: the declared TER is
    // a fact about the security, so it is priced rather than waved away.
    const cost = portfolioCost({
      grossAssets: eur(10_000_00),
      holdings: [
        {
          id: "mislabelled",
          instrument: "stock",
          securityId: { kind: "isin", value: "IE00B4L5Y983" },
          value: eur(10_000_00),
        },
      ],
      profiles: profilesOf(profile("IE00B4L5Y983", "0.002")),
    });

    expect(cost.annualCost).toEqual(eur(20_00));
    expect(cost.coverage.classified).toEqual(eur(10_000_00));
  });

  test("with no TER declared anywhere there is no mean to print — not a 0 %", () => {
    const cost = portfolioCost({
      grossAssets: eur(10_000_00),
      holdings: [
        {
          id: "world",
          instrument: "fund",
          securityId: { kind: "isin", value: "IE00B4L5Y983" },
          value: eur(10_000_00),
        },
      ],
      profiles: new Map(),
    });

    expect(cost.weightedTer).toBeNull();
    expect(cost.annualCost).toEqual(eur(0));
    expect(cost.declaredShare).toBe("0");
    expect(cost.coverage.unknown).toEqual(eur(10_000_00));
  });

  test("an empty portfolio resolves to an empty lens without dividing by zero", () => {
    const cost = portfolioCost({
      grossAssets: eur(0),
      holdings: [],
      profiles: new Map(),
    });

    expect(cost.weightedTer).toBeNull();
    expect(cost.declaredShare).toBe("0");
    expect(cost.annualCost).toEqual(eur(0));
  });

  test("a declared 0 % is a fact: it is priced at nothing and counts as covered", () => {
    const cost = portfolioCost({
      grossAssets: eur(10_000_00),
      holdings: [
        {
          id: "free",
          instrument: "etf",
          securityId: { kind: "isin", value: "IE00B4L5Y983" },
          value: eur(10_000_00),
        },
      ],
      profiles: profilesOf(profile("IE00B4L5Y983", "0")),
    });

    expect(cost.weightedTer).toBe("0");
    expect(cost.declaredShare).toBe("1");
    expect(cost.coverage.unknown).toEqual(eur(0));
  });

  test("finds each profile by the look-through's own key: DGS code or provider symbol", () => {
    // A pension plan has no ISIN — its row lives under `dgs:…`; an unidentified
    // ETF is found by its provider symbol (`isin ?? providerSymbol`, #1745).
    const cost = portfolioCost({
      grossAssets: eur(30_000_00),
      holdings: [
        {
          id: "plan",
          instrument: "pension_plan",
          providerSymbol: "N0000-Gestora",
          securityId: { kind: "dgs", value: "N0000" },
          value: eur(20_000_00),
        },
        {
          id: "etf",
          instrument: "etf",
          providerSymbol: "VWCE.DE",
          securityId: null,
          value: eur(10_000_00),
        },
      ],
      profiles: profilesOf(profile("dgs:N0000", "0.003"), profile("VWCE.DE", "0.0022")),
    });

    // 20.000 € × 0,3 % + 10.000 € × 0,22 % = 60 € + 22 € = 82 €.
    expect(cost.annualCost).toEqual(eur(82_00));
    expect(cost.coverage.unknown).toEqual(eur(0));
  });

  test("a value still in a foreign currency is refused, never summed 1:1 (#1065)", () => {
    expect(() =>
      portfolioCost({
        grossAssets: eur(10_000_00),
        holdings: [
          {
            id: "usd-etf",
            instrument: "etf",
            securityId: { kind: "isin", value: "IE00B5BMR087" },
            value: { amountMinor: 10_000_00, currency: "USD" },
          },
        ],
        profiles: profilesOf(profile("IE00B5BMR087", "0.0007")),
      }),
    ).toThrow(/FX/);
  });
});
