/**
 * Holding → valuation-method dispatch (#152, ADR 0014).
 *
 * The detail page fans out by the holding's valuation method; these helpers are
 * the single decision seam. They must agree with the existing derivation
 * (instrument defaults for assets, debt model for liabilities).
 */
import { describe, expect, test } from "vitest";

import {
  isValueUpdateEligible,
  valuationMethodOfAsset,
  valuationMethodOfLiability,
} from "./holding-method";
import type { Instrument } from "./instrument-catalog";
import type { AssetType, ManualAsset } from "./workspace-types";

function asset(overrides: Partial<ManualAsset> = {}): ManualAsset {
  return {
    id: "asset_1",
    name: "Holding",
    type: "manual",
    currency: "EUR",
    currentValue: { amountMinor: 0, currency: "EUR" },
    liquidityTier: "illiquid",
    ownership: [],
    isPrimaryResidence: false,
    ...overrides,
  };
}

describe("valuationMethodOfAsset (#152)", () => {
  test("an investment is derived (units × price)", () => {
    expect(
      valuationMethodOfAsset(asset({ type: "investment", instrument: "fund" })),
    ).toBe("derived");
  });

  test("a property appreciates", () => {
    expect(
      valuationMethodOfAsset(asset({ type: "real_estate", instrument: "property" })),
    ).toBe("appreciating");
  });

  test("cash and manual are valued by hand (stored)", () => {
    expect(
      valuationMethodOfAsset(asset({ type: "cash", instrument: "current_account" })),
    ).toBe("stored");
    expect(valuationMethodOfAsset(asset({ type: "manual", instrument: "other" }))).toBe(
      "stored",
    );
  });

  test("a primary residence appreciates even without an explicit instrument", () => {
    // No instrument column → derived from type/isPrimaryResidence (property).
    const withoutInstrument = asset({ type: "cash", isPrimaryResidence: true });
    delete withoutInstrument.instrument;
    expect(valuationMethodOfAsset(withoutInstrument)).toBe("appreciating");
  });

  test.each<[Instrument, string]>([
    ["etf", "derived"],
    ["stock", "derived"],
    ["crypto", "derived"],
    ["pension_plan", "derived"],
    ["precious_metal", "stored"],
    ["vehicle", "stored"],
  ])("instrument %s → %s", (instrument, method) => {
    expect(valuationMethodOfAsset(asset({ type: "investment", instrument }))).toBe(
      method,
    );
  });
});

describe("isValueUpdateEligible — who appears in the manual value-update pass (ADR 0016)", () => {
  test("hand-valued holdings (stored / appreciating) are eligible", () => {
    expect(
      isValueUpdateEligible(asset({ type: "cash", instrument: "current_account" })),
    ).toBe(true);
    expect(isValueUpdateEligible(asset({ type: "manual", instrument: "other" }))).toBe(
      true,
    );
    expect(
      isValueUpdateEligible(asset({ type: "real_estate", instrument: "property" })),
    ).toBe(true);
  });

  test("derived holdings are excluded — investments and connected-source coin collections", () => {
    expect(isValueUpdateEligible(asset({ type: "investment", instrument: "fund" }))).toBe(
      false,
    );
    expect(isValueUpdateEligible(asset({ instrument: "coin_collection" }))).toBe(false);
  });
});

describe("valuationMethodOfLiability (#152)", () => {
  test("an amortizable loan is amortized", () => {
    expect(valuationMethodOfLiability("amortizable")).toBe("amortized");
  });

  test("revolving and informal debts are anchored", () => {
    expect(valuationMethodOfLiability("revolving")).toBe("anchored");
    expect(valuationMethodOfLiability("informal")).toBe("anchored");
  });

  test("a liability with no model keeps a stored balance", () => {
    expect(valuationMethodOfLiability(null)).toBe("stored");
  });
});

// Type-only guard: the asset helper consumes a ManualAsset (so all four
// AssetTypes route), and the liability helper consumes a DebtModel | null.
const _typecheck: AssetType = "investment";
void _typecheck;
