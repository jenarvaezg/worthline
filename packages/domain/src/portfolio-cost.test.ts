import { describe, expect, test } from "vitest";

import type { ExposureLookthroughHolding, ExposureProfile } from "./exposure-lookthrough";
import { portfolioCost } from "./portfolio-cost";

/**
 * The portfolio-cost lens (#1717, ADR 0109): Σ value × TER and the value-weighted
 * mean TER over the part of gross whose TER is declared, with the look-through's
 * coverage honesty — an undeclared TER is a gap, never a 0. It reads the
 * look-through's own input, so every fixture here could feed `lookThroughExposure`.
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

function holding(
  id: string,
  instrument: ExposureLookthroughHolding["instrument"],
  valueMinor: number,
  identity: Pick<ExposureLookthroughHolding, "securityId" | "providerSymbol"> = {},
): ExposureLookthroughHolding {
  return { currency: EUR, id, instrument, valueMinor, ...identity };
}

const isin = (value: string) => ({ securityId: { kind: "isin" as const, value } });

describe("portfolioCost", () => {
  test("weights each declared TER by value and prices the year in euros", () => {
    // 60.000 € at 0,22 % + 40.000 € at 0,12 % = 132 € + 48 € = 180 €/año, and
    // 180 € over the 100.000 € that carry a TER is a mean of 0,18 %.
    const cost = portfolioCost({
      grossAssets: eur(100_000_00),
      holdings: [
        holding("world", "fund", 60_000_00, isin("IE00B4L5Y983")),
        holding("sp500", "etf", 40_000_00, isin("IE00B5BMR087")),
      ],
      profiles: profilesOf(
        profile("IE00B4L5Y983", "0.0022"),
        profile("IE00B5BMR087", "0.0012"),
      ),
      undetailedAggregateIds: new Set(),
    });

    expect(cost.annualCost).toEqual(eur(180_00));
    expect(cost.weightedTer).toBe("0.0018");
    expect(cost.declaredShare).toBe("1");
    expect(cost.coverage).toEqual({
      declared: eur(100_000_00),
      notApplicable: eur(0),
      undeclared: eur(0),
    });
  });

  test("an undeclared TER is a coverage gap, never a 0 that dilutes the mean", () => {
    // Only the 60.000 € fund declares a TER. Counting the other 40.000 € (a
    // profile with `ter: null` and a fund the catalog does not know) as 0 % would
    // print a mean of 0,132 %; the honest mean is 0,22 % over 60 % of gross.
    const cost = portfolioCost({
      grossAssets: eur(100_000_00),
      holdings: [
        holding("world", "fund", 60_000_00, isin("IE00B4L5Y983")),
        holding("bonds", "fund", 30_000_00, isin("IE00B3F81409")),
        holding("uncatalogued", "etf", 10_000_00, {
          providerSymbol: "NOPE.DE",
          securityId: null,
        }),
      ],
      profiles: profilesOf(
        profile("IE00B4L5Y983", "0.0022"),
        profile("IE00B3F81409", null),
      ),
      undetailedAggregateIds: new Set(),
    });

    expect(cost.annualCost).toEqual(eur(132_00));
    expect(cost.weightedTer).toBe("0.0022");
    expect(cost.declaredShare).toBe("0.6");
    expect(cost.coverage).toEqual({
      declared: eur(60_000_00),
      notApplicable: eur(0),
      undeclared: eur(40_000_00),
    });
  });

  test("what has no fund wrapper charges no TER: it is not applicable, not a gap", () => {
    // Cash, a house, crypto and a directly held share carry no ongoing charge,
    // so they neither dilute the mean nor read as a TER nobody declared.
    const cost = portfolioCost({
      grossAssets: eur(100_000_00),
      holdings: [
        holding("world", "fund", 50_000_00, isin("IE00B4L5Y983")),
        holding("cash", "current_account", 20_000_00),
        holding("flat", "property", 15_000_00),
        holding("btc", "crypto", 5_000_00),
        holding("share", "stock", 10_000_00, isin("US0378331005")),
      ],
      profiles: profilesOf(
        profile("IE00B4L5Y983", "0.002"),
        // A share's catalog row describes its sector and region, never a TER.
        profile("US0378331005", null),
      ),
      undetailedAggregateIds: new Set(),
    });

    expect(cost.annualCost).toEqual(eur(100_00));
    expect(cost.weightedTer).toBe("0.002");
    // Every euro that could charge a TER declares one (#1840).
    expect(cost.declaredShare).toBe("1");
    expect(cost.coverage).toEqual({
      declared: eur(50_000_00),
      notApplicable: eur(50_000_00),
      undeclared: eur(0),
    });
  });

  test("the coverage share is over what charges a TER: a flat never reads as a gap (#1840)", () => {
    // A 250.000 € flat next to 80.000 € in funds that all declare a TER: over the
    // whole gross this read «24 %», as if 76 % had no figure. Over what charges a
    // TER, the portfolio is fully covered.
    const cost = portfolioCost({
      grossAssets: eur(330_000_00),
      holdings: [
        holding("flat", "property", 250_000_00),
        holding("world", "fund", 50_000_00, isin("IE00B4L5Y983")),
        holding("sp500", "etf", 30_000_00, isin("IE00B5BMR087")),
      ],
      profiles: profilesOf(
        profile("IE00B4L5Y983", "0.0022"),
        profile("IE00B5BMR087", "0.0012"),
      ),
      undetailedAggregateIds: new Set(),
    });

    expect(cost.declaredShare).toBe("1");
    expect(cost.coverage.notApplicable).toEqual(eur(250_000_00));
  });

  test("the share's gap is only the undeclared part, never the not applicable one (#1840)", () => {
    // 60.000 € with a TER + 20.000 € of a fund nobody declared + a 250.000 € flat:
    // 60.000 over the 80.000 € that charge a TER is 75 %.
    const cost = portfolioCost({
      grossAssets: eur(330_000_00),
      holdings: [
        holding("world", "fund", 60_000_00, isin("IE00B4L5Y983")),
        holding("bonds", "fund", 20_000_00, isin("IE00B3F81409")),
        holding("flat", "property", 250_000_00),
      ],
      profiles: profilesOf(profile("IE00B4L5Y983", "0.0022")),
      undetailedAggregateIds: new Set(),
    });

    expect(cost.declaredShare).toBe("0.75");
  });

  test("a managed portfolio's undetailed aggregate is part of the share's base (#1810, #1840)", () => {
    // 30.000 € with a TER + 10.000 € of a portfolio's «(sin detallar)» aggregate:
    // the aggregate is funds nobody enumerated, so it counts against the share;
    // the portfolio's 2.000 € cash box charges nothing, so it does not.
    const cost = portfolioCost({
      grossAssets: eur(42_000_00),
      holdings: [
        holding("world", "fund", 30_000_00, isin("IE00B4L5Y983")),
        holding("aggregate", "other", 10_000_00),
        holding("box", "current_account", 2_000_00),
      ],
      profiles: profilesOf(profile("IE00B4L5Y983", "0.002")),
      undetailedAggregateIds: new Set(["aggregate"]),
    });

    expect(cost.declaredShare).toBe("0.75");
  });

  test("with nothing that charges a TER the share stays 0, never a division by zero (#1840)", () => {
    const cost = portfolioCost({
      grossAssets: eur(10_000_00),
      holdings: [holding("cash", "current_account", 10_000_00)],
      profiles: profilesOf(),
      undetailedAggregateIds: new Set(),
    });

    expect(cost.declaredShare).toBe("0");
    expect(cost.weightedTer).toBeNull();
  });

  test("a «solo saldo» managed portfolio is a TER gap, never something that charges none (#1810)", () => {
    // A MyInvestor portfolio registered by its balance alone: 20.000 € invested
    // in funds nobody enumerated, plus the 500 € waiting in its cash box. The
    // aggregate is an `other` holding, but what it IS is invested money — the
    // gap; the box is still cash, which charges nothing.
    const cost = portfolioCost({
      grossAssets: eur(20_500_00),
      holdings: [
        holding("aggregate", "other", 20_000_00),
        holding("box", "current_account", 500_00),
      ],
      profiles: profilesOf(),
      undetailedAggregateIds: new Set(["aggregate"]),
    });

    expect(cost.weightedTer).toBeNull();
    expect(cost.annualCost).toEqual(eur(0));
    expect(cost.coverage).toEqual({
      declared: eur(0),
      notApplicable: eur(500_00),
      undeclared: eur(20_000_00),
    });
  });

  test("funds with a TER next to the undetailed aggregate leave the aggregate as the gap (#1810)", () => {
    // 30.000 € at 0,2 % = 60 €/año; the 10.000 € nobody detailed must show as
    // undeclared, not quietly as «No aplica». An `other` held OUTSIDE any
    // portfolio (a watch, say) is decided by what it is, so it stays not
    // applicable — the label alone never makes a gap.
    const cost = portfolioCost({
      grossAssets: eur(45_000_00),
      holdings: [
        holding("world", "fund", 30_000_00, isin("IE00B4L5Y983")),
        holding("aggregate", "other", 10_000_00),
        holding("watch", "other", 5_000_00),
      ],
      profiles: profilesOf(profile("IE00B4L5Y983", "0.002")),
      undetailedAggregateIds: new Set(["aggregate"]),
    });

    expect(cost.annualCost).toEqual(eur(60_00));
    expect(cost.weightedTer).toBe("0.002");
    expect(cost.coverage).toEqual({
      declared: eur(30_000_00),
      notApplicable: eur(5_000_00),
      undeclared: eur(10_000_00),
    });
  });

  test("a TER the catalog declares wins, whatever the instrument says", () => {
    // A holding typed `stock` that is really a fund wrapper: the declared TER is
    // a fact about the security, so it is priced rather than waved away.
    const cost = portfolioCost({
      grossAssets: eur(10_000_00),
      holdings: [holding("mislabelled", "stock", 10_000_00, isin("IE00B4L5Y983"))],
      profiles: profilesOf(profile("IE00B4L5Y983", "0.002")),
      undetailedAggregateIds: new Set(),
    });

    expect(cost.annualCost).toEqual(eur(20_00));
    expect(cost.coverage.declared).toEqual(eur(10_000_00));
  });

  test("with no TER declared anywhere there is no mean to print — not a 0 %", () => {
    const cost = portfolioCost({
      grossAssets: eur(10_000_00),
      holdings: [holding("world", "fund", 10_000_00, isin("IE00B4L5Y983"))],
      profiles: new Map(),
      undetailedAggregateIds: new Set(),
    });

    expect(cost.weightedTer).toBeNull();
    expect(cost.annualCost).toEqual(eur(0));
    expect(cost.declaredShare).toBe("0");
    expect(cost.coverage.undeclared).toEqual(eur(10_000_00));
  });

  test("an empty portfolio resolves to an empty lens without dividing by zero", () => {
    const cost = portfolioCost({
      grossAssets: eur(0),
      holdings: [],
      profiles: new Map(),
      undetailedAggregateIds: new Set(),
    });

    expect(cost.weightedTer).toBeNull();
    expect(cost.declaredShare).toBe("0");
    expect(cost.annualCost).toEqual(eur(0));
  });

  test("a declared 0 % is a fact: it is priced at nothing and counts as covered", () => {
    const cost = portfolioCost({
      grossAssets: eur(10_000_00),
      holdings: [holding("free", "etf", 10_000_00, isin("IE00B4L5Y983"))],
      profiles: profilesOf(profile("IE00B4L5Y983", "0")),
      undetailedAggregateIds: new Set(),
    });

    expect(cost.weightedTer).toBe("0");
    expect(cost.declaredShare).toBe("1");
    expect(cost.coverage.undeclared).toEqual(eur(0));
  });

  test("finds each profile by the look-through's own key: DGS code or provider symbol", () => {
    // A pension plan has no ISIN — its row lives under `dgs:…`; an unidentified
    // ETF is found by its provider symbol (`isin ?? providerSymbol`, #1745).
    const cost = portfolioCost({
      grossAssets: eur(30_000_00),
      holdings: [
        holding("plan", "pension_plan", 20_000_00, {
          providerSymbol: "N0000-Gestora",
          securityId: { kind: "dgs", value: "N0000" },
        }),
        holding("etf", "etf", 10_000_00, { providerSymbol: "VWCE.DE", securityId: null }),
      ],
      profiles: profilesOf(profile("dgs:N0000", "0.003"), profile("VWCE.DE", "0.0022")),
      undetailedAggregateIds: new Set(),
    });

    // 20.000 € × 0,3 % + 10.000 € × 0,22 % = 60 € + 22 € = 82 €.
    expect(cost.annualCost).toEqual(eur(82_00));
    expect(cost.coverage.undeclared).toEqual(eur(0));
  });

  test("a foreign-denominated holding is priced on its converted value, not its currency", () => {
    // A USD ETF whose 9.000 € (already through the FX layer) carry a 0,07 % TER
    // costs 6,30 €: the denomination is exposure information, the value is euros.
    const cost = portfolioCost({
      grossAssets: eur(9_000_00),
      holdings: [
        { ...holding("usd-etf", "etf", 9_000_00, isin("IE00B5BMR087")), currency: "USD" },
      ],
      profiles: profilesOf(profile("IE00B5BMR087", "0.0007")),
      undetailedAggregateIds: new Set(),
    });

    expect(cost.annualCost).toEqual(eur(6_30));
    expect(cost.coverage.declared).toEqual(eur(9_000_00));
  });
});
