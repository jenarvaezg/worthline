/**
 * Instrument catalog (#149, ADR 0014).
 *
 * An instrument is *what* a holding is. The catalog is the single table that maps
 * each instrument to its defaults — where it lands on the liquidity ladder, how it
 * is valued, and which price provider feeds it — replacing defaults that were
 * scattered across the codebase (provider-by-tier, the forced real_estate→housing).
 */
import { describe, expect, test } from "vitest";

import {
  defaultInstrumentForAssetType,
  defaultInstrumentForLiability,
  defaultsFor,
  instrumentForQuoteType,
} from "./instrument-catalog";
import type { Instrument, InstrumentDefaults } from "./instrument-catalog";

describe("defaultsFor — instrument defaults (#149)", () => {
  test("a property is illiquid and appreciates", () => {
    const defaults = defaultsFor("property");

    expect(defaults.rung).toBe("illiquid");
    expect(defaults.valuationMethod).toBe("appreciating");
  });

  test("a fund is a market security valued from units × price, priced by Yahoo", () => {
    const defaults = defaultsFor("fund");

    expect(defaults.rung).toBe("market");
    expect(defaults.valuationMethod).toBe("derived");
    expect(defaults.priceProvider).toBe("yahoo");
  });

  test("a pension plan is term-locked, derived, and priced by Finect", () => {
    const defaults = defaultsFor("pension_plan");

    expect(defaults.rung).toBe("term-locked");
    expect(defaults.valuationMethod).toBe("derived");
    expect(defaults.priceProvider).toBe("finect");
  });

  test("crypto is a derived market holding whose default provider is CoinGecko", () => {
    const defaults = defaultsFor("crypto");

    expect(defaults.rung).toBe("market");
    expect(defaults.valuationMethod).toBe("derived");
    expect(defaults.priceProvider).toBe("coingecko");
  });

  test("a coin collection is illiquid and derived from its positions (ADR 0016)", () => {
    // The projected "Colección Numista" holding: value computed from its
    // positions (never hand-set), so it is `derived` — no sixth valuation
    // method — and it sits on the illiquid rung. It is priced from its
    // positions, not by a market provider, so it carries no priceProvider.
    const defaults = defaultsFor("coin_collection");

    expect(defaults.rung).toBe("illiquid");
    expect(defaults.valuationMethod).toBe("derived");
    expect(defaults.priceProvider).toBeUndefined();
  });
});

describe("defaultsFor — storage defaults the create-holding seam reads (#309)", () => {
  // The catalog owns the per-instrument storage knowledge the create-holding
  // action used to carry as inline dispatch maps: which legacy AssetType an
  // asset instrument persists as, and how a debt instrument persists (its
  // LiabilityType + the debt model that fixes its valuation method).

  test("each stored/appreciating asset instrument carries its legacy AssetType", () => {
    expect(defaultsFor("current_account").assetType).toBe("cash");
    expect(defaultsFor("term_deposit").assetType).toBe("manual");
    expect(defaultsFor("precious_metal").assetType).toBe("manual");
    expect(defaultsFor("vehicle").assetType).toBe("manual");
    expect(defaultsFor("other").assetType).toBe("manual");
    expect(defaultsFor("property").assetType).toBe("real_estate");
  });

  test("a derived investment instrument carries no legacy AssetType", () => {
    // Investments persist through the investment path, not the manual-asset
    // path, so they declare no stored AssetType.
    expect(defaultsFor("fund").assetType).toBeUndefined();
    expect(defaultsFor("crypto").assetType).toBeUndefined();
    expect(defaultsFor("pension_plan").assetType).toBeUndefined();
  });

  test("each debt instrument carries its LiabilityType + default debt model", () => {
    expect(defaultsFor("mortgage").liability).toEqual({
      type: "mortgage",
      debtModel: "amortizable",
    });
    expect(defaultsFor("loan").liability).toEqual({
      type: "debt",
      debtModel: "amortizable",
    });
    expect(defaultsFor("credit_card").liability).toEqual({
      type: "debt",
      debtModel: "revolving",
    });
  });

  test("a non-debt instrument carries no liability spec", () => {
    expect(defaultsFor("current_account").liability).toBeUndefined();
    expect(defaultsFor("property").liability).toBeUndefined();
    expect(defaultsFor("fund").liability).toBeUndefined();
  });
});

describe("defaultsFor — covers every instrument (#149 AC)", () => {
  // The whole catalog, asserted as a table: every instrument must have an entry,
  // and the methods mirror the S2 valuation_method backfill so a later slice can
  // make the instrument authoritative for valuation without shifting any figure.
  const EXPECTED: Record<Instrument, InstrumentDefaults> = {
    current_account: { rung: "cash", valuationMethod: "stored", assetType: "cash" },
    term_deposit: {
      rung: "term-locked",
      valuationMethod: "stored",
      assetType: "manual",
    },
    fund: { rung: "market", valuationMethod: "derived", priceProvider: "yahoo" },
    etf: { rung: "market", valuationMethod: "derived", priceProvider: "yahoo" },
    stock: { rung: "market", valuationMethod: "derived", priceProvider: "yahoo" },
    index: { rung: "market", valuationMethod: "derived", priceProvider: "yahoo" },
    pension_plan: {
      rung: "term-locked",
      valuationMethod: "derived",
      priceProvider: "finect",
    },
    crypto: { rung: "market", valuationMethod: "derived", priceProvider: "coingecko" },
    precious_metal: { rung: "illiquid", valuationMethod: "stored", assetType: "manual" },
    vehicle: { rung: "illiquid", valuationMethod: "stored", assetType: "manual" },
    property: {
      rung: "illiquid",
      valuationMethod: "appreciating",
      assetType: "real_estate",
    },
    mortgage: {
      rung: "illiquid",
      valuationMethod: "amortized",
      liability: { type: "mortgage", debtModel: "amortizable" },
    },
    loan: {
      rung: "cash",
      valuationMethod: "amortized",
      liability: { type: "debt", debtModel: "amortizable" },
    },
    credit_card: {
      rung: "cash",
      valuationMethod: "anchored",
      liability: { type: "debt", debtModel: "revolving" },
    },
    other: { rung: "illiquid", valuationMethod: "stored", assetType: "manual" },
    coin_collection: { rung: "illiquid", valuationMethod: "derived" },
  };

  test.each(Object.keys(EXPECTED) as Instrument[])(
    "%s resolves to its catalog defaults",
    (instrument) => {
      expect(defaultsFor(instrument)).toEqual(EXPECTED[instrument]);
    },
  );
});

describe("instrumentForQuoteType — symbol-search prefill (#149, folds in #139)", () => {
  test("maps each provider quote type to its instrument", () => {
    expect(instrumentForQuoteType("MUTUALFUND")).toBe("fund");
    expect(instrumentForQuoteType("ETF")).toBe("etf");
    expect(instrumentForQuoteType("EQUITY")).toBe("stock");
    expect(instrumentForQuoteType("INDEX")).toBe("index");
    expect(instrumentForQuoteType("PENSIONPLAN")).toBe("pension_plan");
  });

  test("falls back to 'other' for an unknown or absent quote type", () => {
    expect(instrumentForQuoteType("CRYPTOCURRENCY")).toBe("other");
    expect(instrumentForQuoteType(undefined)).toBe("other");
  });
});

describe("defaultInstrumentForAssetType — backfill from the legacy AssetType (#149)", () => {
  test("maps each asset type to its instrument", () => {
    expect(defaultInstrumentForAssetType("real_estate", false)).toBe("property");
    expect(defaultInstrumentForAssetType("cash", false)).toBe("current_account");
    expect(defaultInstrumentForAssetType("manual", false)).toBe("other");
    expect(defaultInstrumentForAssetType("investment", false)).toBe("fund");
  });

  test("a primary residence is a property whatever its legacy type (housing bridge)", () => {
    // Mirrors isHousingAsset's old rule: real_estate OR primary residence. A
    // manual-typed primary residence must still resolve to property so housing
    // equity stays byte-identical when it is re-sourced from instrument.
    expect(defaultInstrumentForAssetType("manual", true)).toBe("property");
    expect(defaultInstrumentForAssetType("cash", true)).toBe("property");
  });
});

describe("defaultInstrumentForLiability — backfill from type + debt model (#149)", () => {
  test("a mortgage is a mortgage whatever its model", () => {
    expect(defaultInstrumentForLiability("mortgage", "amortizable")).toBe("mortgage");
    expect(defaultInstrumentForLiability("mortgage", null)).toBe("mortgage");
  });

  test("a revolving debt is a credit card; other debts are loans", () => {
    expect(defaultInstrumentForLiability("debt", "revolving")).toBe("credit_card");
    expect(defaultInstrumentForLiability("debt", "amortizable")).toBe("loan");
    expect(defaultInstrumentForLiability("debt", "informal")).toBe("loan");
    expect(defaultInstrumentForLiability("debt", null)).toBe("loan");
  });
});
