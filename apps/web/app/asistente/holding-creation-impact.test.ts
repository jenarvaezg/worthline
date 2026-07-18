import type { HoldingCreationPlan } from "@worthline/db";
import { describe, expect, test } from "vitest";

import {
  holdingCreationImpact,
  signedNetWorthContributionMinor,
} from "./holding-creation-impact";

const FULL = [{ memberId: "m", shareBps: 10_000 }];

describe("signedNetWorthContributionMinor (#1105)", () => {
  test("a stored asset adds its current value", () => {
    const plan: HoldingCreationPlan = {
      currentValueMinor: 2_500_00,
      family: "stored",
      instrument: "current_account",
      name: "Cuenta BBVA",
      ownership: FULL,
    };
    expect(signedNetWorthContributionMinor(plan)).toBe(2_500_00);
  });

  test("an appreciating asset adds its current value", () => {
    const plan: HoldingCreationPlan = {
      currentValueMinor: 200_000_00,
      family: "appreciating",
      instrument: "property",
      isPrimaryResidence: true,
      name: "Piso",
      ownership: FULL,
    };
    expect(signedNetWorthContributionMinor(plan)).toBe(200_000_00);
  });

  test("a debt subtracts its balance", () => {
    const plan: HoldingCreationPlan = {
      balanceMinor: 120_000_00,
      debtModel: "amortizable",
      family: "debt",
      instrument: "mortgage",
      name: "Hipoteca",
      ownership: FULL,
    };
    expect(signedNetWorthContributionMinor(plan)).toBe(-120_000_00);
  });

  test("an investment with an opening adds its value; empty adds nothing", () => {
    const withOpening: HoldingCreationPlan = {
      family: "investment",
      instrument: "fund",
      name: "Fondo",
      opening: { pricePerUnit: "150", units: "10", valueMinor: 1_500_00 },
      ownership: FULL,
    };
    const empty: HoldingCreationPlan = {
      family: "investment",
      instrument: "fund",
      name: "Fondo vacío",
      ownership: FULL,
    };
    expect(signedNetWorthContributionMinor(withOpening)).toBe(1_500_00);
    expect(signedNetWorthContributionMinor(empty)).toBe(0);
  });

  test("ownership weighting scales the contribution by total bps", () => {
    const plan: HoldingCreationPlan = {
      currentValueMinor: 100_000_00,
      family: "appreciating",
      instrument: "property",
      isPrimaryResidence: false,
      name: "Segunda vivienda",
      ownership: [{ memberId: "m", shareBps: 7_500 }],
    };
    // 75% of 100.000 € = 75.000 €.
    expect(signedNetWorthContributionMinor(plan)).toBe(75_000_00);
  });
});

describe("holdingCreationImpact (#1105)", () => {
  test("after = before + delta for an asset", () => {
    const plan: HoldingCreationPlan = {
      currentValueMinor: 2_500_00,
      family: "stored",
      instrument: "current_account",
      name: "Cuenta",
      ownership: FULL,
    };
    expect(holdingCreationImpact(10_000_00, plan)).toEqual({
      afterMinor: 12_500_00,
      beforeMinor: 10_000_00,
      deltaMinor: 2_500_00,
    });
  });

  test("a debt lowers the after net worth", () => {
    const plan: HoldingCreationPlan = {
      balanceMinor: 6_000_00,
      debtModel: "revolving",
      family: "debt",
      instrument: "credit_card",
      name: "Tarjeta",
      ownership: FULL,
    };
    expect(holdingCreationImpact(10_000_00, plan)).toEqual({
      afterMinor: 4_000_00,
      beforeMinor: 10_000_00,
      deltaMinor: -6_000_00,
    });
  });

  test("a degraded net-worth read keeps the delta but no fabricated total", () => {
    // `null` before (failed read) must not become a 0 € figure the card never
    // read (ADR 0048): the delta stays known, before/after are unavailable.
    const plan: HoldingCreationPlan = {
      currentValueMinor: 2_500_00,
      family: "stored",
      instrument: "current_account",
      name: "Cuenta",
      ownership: FULL,
    };
    expect(holdingCreationImpact(null, plan)).toEqual({
      afterMinor: null,
      beforeMinor: null,
      deltaMinor: 2_500_00,
    });
  });
});
