import { describe, expect, test } from "vitest";
import { defaultsFor, INSTRUMENTS } from "./instrument-catalog";
import {
  assignableInstruments,
  assignableInstrumentsForHolding,
  assignableInstrumentsForShape,
  instrumentCorrectionMove,
  instrumentPickerImpact,
  instrumentShape,
  isAssignableInstrument,
  isAssignableInstrumentForHolding,
  isAssignableInstrumentForShape,
  keepsKnownPartialOwnership,
  ownershipShortfallOnCorrection,
  shapeOfHolding,
} from "./instrument-correction";

describe("shapeOfHolding — the row's shape, not its column's (#1691)", () => {
  const mislabelled = { connectedSourceId: "src_1", instrument: "other" } as const;

  test("a connected holding is `connected` whatever its instrument says", () => {
    // The v14 backfill filed every pre-migration collection as `other`, which is a
    // `manual` shape — so the mislabelled row was the one the ficha offered to
    // relabel, and `coin_collection` was not even among the offers.
    expect(shapeOfHolding(mislabelled)).toBe("connected");
    expect(assignableInstrumentsForHolding(mislabelled)).toEqual([]);
    expect(isAssignableInstrumentForHolding(mislabelled, "vehicle")).toBe(false);
  });

  test("a hand-kept holding still answers its instrument's shape", () => {
    const handKept = { connectedSourceId: null, instrument: "other" } as const;
    expect(shapeOfHolding(handKept)).toBe("manual");
    expect(assignableInstrumentsForHolding(handKept)).toEqual(
      assignableInstruments("other"),
    );
  });
});

describe("instrumentShape (#1512)", () => {
  test("groups the hand-valued asset instruments as `manual`", () => {
    expect(instrumentShape("current_account")).toBe("manual");
    expect(instrumentShape("term_deposit")).toBe("manual");
    expect(instrumentShape("precious_metal")).toBe("manual");
    expect(instrumentShape("vehicle")).toBe("manual");
    expect(instrumentShape("other")).toBe("manual");
    // A property is hand-valued too — its curve rides on the same asset row.
    expect(instrumentShape("property")).toBe("manual");
  });

  test("groups the ledger-backed instruments as `investment`", () => {
    for (const instrument of [
      "fund",
      "etf",
      "stock",
      "index",
      "pension_plan",
      "crypto",
    ] as const) {
      expect(instrumentShape(instrument)).toBe("investment");
    }
  });

  test("keeps a connected-source collection and every debt out of both", () => {
    expect(instrumentShape("coin_collection")).toBe("connected");
    expect(instrumentShape("mortgage")).toBe("debt");
    expect(instrumentShape("loan")).toBe("debt");
    expect(instrumentShape("credit_card")).toBe("debt");
  });

  test("places every instrument in the catalog — a new one cannot fall through", () => {
    for (const instrument of INSTRUMENTS) {
      expect(["manual", "investment", "connected", "debt"]).toContain(
        instrumentShape(instrument),
      );
    }
  });
});

describe("assignableInstruments (#1512)", () => {
  test("offers a misfiled property every hand-valued instrument, itself included", () => {
    expect(assignableInstruments("property")).toEqual([
      "current_account",
      "term_deposit",
      "precious_metal",
      "vehicle",
      "property",
      "other",
    ]);
  });

  test("offers a fund the ledger-backed instruments only", () => {
    expect(assignableInstruments("fund")).toEqual([
      "fund",
      "etf",
      "stock",
      "index",
      "pension_plan",
      "crypto",
    ]);
  });

  test("never crosses persistence shapes — a manual asset has no operations ledger", () => {
    expect(assignableInstruments("other")).not.toContain("pension_plan");
    expect(assignableInstruments("pension_plan")).not.toContain("property");
  });

  test("offers nothing for a connected collection or a debt", () => {
    expect(assignableInstruments("coin_collection")).toEqual([]);
    expect(assignableInstruments("mortgage")).toEqual([]);
  });

  test("keeps every offer valuation-compatible with its own shape", () => {
    for (const current of INSTRUMENTS) {
      for (const next of assignableInstruments(current)) {
        expect(instrumentShape(next)).toBe(instrumentShape(current));
      }
    }
  });

  test("gates a correction through the same list", () => {
    expect(isAssignableInstrument("property", "other")).toBe(true);
    expect(isAssignableInstrument("property", "property")).toBe(true);
    expect(isAssignableInstrument("property", "pension_plan")).toBe(false);
    expect(isAssignableInstrument("coin_collection", "other")).toBe(false);
  });
});

describe("instrumentCorrectionMove (#1512)", () => {
  test("moves a property off the immobilized side when the declared rung is liquid", () => {
    const move = instrumentCorrectionMove({
      from: "property",
      liquidityTier: "term-locked",
      to: "term_deposit",
    });

    expect(move.fromTier).toBe("housing");
    expect(move.toTier).toBe("term-locked");
    expect(move.fromSide).toBe("immobilized");
    expect(move.toSide).toBe("sellable");
    expect(move.movesFireCapitalSide).toBe(true);
  });

  test("keeps both sides immobilized when the declared rung is illiquid", () => {
    const move = instrumentCorrectionMove({
      from: "property",
      liquidityTier: "illiquid",
      to: "other",
    });

    expect(move.fromSide).toBe("immobilized");
    expect(move.toSide).toBe("immobilized");
    expect(move.movesFireCapitalSide).toBe(false);
  });

  test("puts a holding promoted to property back on the housing rung", () => {
    const move = instrumentCorrectionMove({
      from: "current_account",
      liquidityTier: "cash",
      to: "property",
    });

    expect(move.toTier).toBe("housing");
    expect(move.toSide).toBe("immobilized");
    expect(move.movesFireCapitalSide).toBe(true);
  });

  test("reports a no-op correction as moving nothing", () => {
    const move = instrumentCorrectionMove({
      from: "property",
      liquidityTier: "illiquid",
      to: "property",
    });

    expect(move.movesFireCapitalSide).toBe(false);
    expect(move.fromSide).toBe(move.toSide);
  });
});

describe("keepsKnownPartialOwnership (#1512)", () => {
  test("is true only for the instrument whose split may stay under 100 %", () => {
    expect(keepsKnownPartialOwnership("property")).toBe(true);
    expect(keepsKnownPartialOwnership("other")).toBe(false);
    expect(keepsKnownPartialOwnership("current_account")).toBe(false);
  });

  test("tracks the AssetType the alta accepts a partial split for", () => {
    // The web seam gates the partial on `type === "real_estate"`; the instrument
    // that persists as one is the same single instrument.
    for (const instrument of INSTRUMENTS) {
      expect(keepsKnownPartialOwnership(instrument)).toBe(
        defaultsFor(instrument).assetType === "real_estate",
      );
    }
  });
});

describe("instrumentShape — read off the defaults, not off a name list (#1512)", () => {
  test("a `derived` instrument with no price provider is a connected one", () => {
    // `coin_collection` is the only one today. What identifies it is the DATA —
    // derived, but priced from mirrored positions instead of a market provider —
    // so the next connected instrument cannot leak into a correction picker.
    for (const instrument of INSTRUMENTS) {
      const defaults = defaultsFor(instrument);
      const isConnected =
        !defaults.liability && !defaults.assetType && !defaults.priceProvider;
      expect(instrumentShape(instrument) === "connected").toBe(isConnected);
    }
  });
});

describe("assignableInstrumentsForShape — one rule for both gates (#1512)", () => {
  test("agrees with the holding-keyed list for every instrument", () => {
    for (const instrument of INSTRUMENTS) {
      expect(assignableInstrumentsForShape(instrumentShape(instrument))).toEqual(
        assignableInstruments(instrument),
      );
      for (const next of INSTRUMENTS) {
        expect(isAssignableInstrumentForShape(instrumentShape(instrument), next)).toBe(
          isAssignableInstrument(instrument, next),
        );
      }
    }
  });

  test("answers the investment ficha, which cannot read the row", () => {
    expect(isAssignableInstrumentForShape("investment", "pension_plan")).toBe(true);
    expect(isAssignableInstrumentForShape("investment", "property")).toBe(false);
    expect(isAssignableInstrumentForShape("connected", "other")).toBe(false);
  });
});

describe("instrumentPickerImpact (#1512)", () => {
  test("names the offers that would cross the FIRE frontier", () => {
    const impact = instrumentPickerImpact({
      current: "property",
      liquidityTier: "term-locked",
    });

    expect(impact.currentSide).toBe("immobilized");
    // Everything but `property` itself gives the declared `term-locked` rung back.
    expect(impact.crossing).toEqual([
      "current_account",
      "term_deposit",
      "precious_metal",
      "vehicle",
      "other",
    ]);
  });

  test("crosses nothing when the declared rung is immobilized anyway", () => {
    const impact = instrumentPickerImpact({
      current: "property",
      liquidityTier: "illiquid",
    });

    expect(impact.currentSide).toBe("immobilized");
    expect(impact.crossing).toEqual([]);
  });

  test("names `property` alone for a holding on a sellable rung", () => {
    const impact = instrumentPickerImpact({
      current: "term_deposit",
      liquidityTier: "term-locked",
    });

    expect(impact.currentSide).toBe("sellable");
    expect(impact.crossing).toEqual(["property"]);
  });

  test("an investment never crosses — no derived instrument overrides the rung", () => {
    expect(
      instrumentPickerImpact({ current: "fund", liquidityTier: "market" }).crossing,
    ).toEqual([]);
  });
});

describe("ownershipShortfallOnCorrection (#1512)", () => {
  test("reports what a non-property correction would hand the user", () => {
    expect(ownershipShortfallOnCorrection({ enteredBps: 7_500, to: "other" })).toBe(
      2_500,
    );
  });

  test("is silent when the target keeps the partial split", () => {
    expect(ownershipShortfallOnCorrection({ enteredBps: 7_500, to: "property" })).toBe(0);
  });

  test("is silent when the entered split is already full ownership", () => {
    // The legitimate submit that fixes the titularidad AND the instrument at once.
    expect(ownershipShortfallOnCorrection({ enteredBps: 10_000, to: "other" })).toBe(0);
  });
});
