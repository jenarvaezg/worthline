/**
 * Holding-valuation dispatcher (#148, ADR 0014).
 *
 * Pure-module tests: a holding's valuation method decides how its value/balance
 * on a date is computed, delegating to the existing engines (investment
 * valuation, housing valuation, debt balance). Tested per method and across
 * dates — the behaviour the scattered type-based branches used to provide.
 */
import { describe, expect, test } from "vitest";

import {
  defaultValuationMethodForAssetType,
  defaultValuationMethodForDebtModel,
  valueAt,
} from "./holding-valuation";
import type { HoldingValuationInput } from "./holding-valuation";
import type { InvestmentOperation } from "./investment-types";

describe("defaultValuationMethodForAssetType — backfill mapping (#148)", () => {
  test("cash and manual assets are valued by hand (stored)", () => {
    expect(defaultValuationMethodForAssetType("cash")).toBe("stored");
    expect(defaultValuationMethodForAssetType("manual")).toBe("stored");
  });

  test("an investment is derived (units × price)", () => {
    expect(defaultValuationMethodForAssetType("investment")).toBe("derived");
  });

  test("real estate appreciates (revaluation curve)", () => {
    expect(defaultValuationMethodForAssetType("real_estate")).toBe("appreciating");
  });
});

describe("defaultValuationMethodForDebtModel — backfill mapping (#148)", () => {
  test("an amortizable debt is amortized", () => {
    expect(defaultValuationMethodForDebtModel("amortizable")).toBe("amortized");
  });

  test("revolving and informal debts are anchored to declared balances", () => {
    expect(defaultValuationMethodForDebtModel("revolving")).toBe("anchored");
    expect(defaultValuationMethodForDebtModel("informal")).toBe("anchored");
  });

  test("a liability with no model keeps its manual balance (stored)", () => {
    expect(defaultValuationMethodForDebtModel(null)).toBe("stored");
  });
});

describe("valueAt — stored (valued by hand)", () => {
  test("returns the most recent value declared on or before the date", () => {
    const result = valueAt(
      {
        currentValueMinor: 500_00,
        method: "stored",
        valueHistory: [
          { dateKey: "2024-01-01", valueMinor: 100_00 },
          { dateKey: "2024-06-01", valueMinor: 300_00 },
        ],
      },
      "2024-08-01",
    );

    expect(result.valueMinor).toBe(300_00);
  });

  test("falls back to the current value when no history reaches back to the date", () => {
    const result = valueAt(
      {
        currentValueMinor: 500_00,
        method: "stored",
        valueHistory: [{ dateKey: "2025-01-01", valueMinor: 100_00 }],
      },
      "2024-08-01",
    );

    expect(result.valueMinor).toBe(500_00);
  });

  test("falls back to the current value with no history at all", () => {
    const result = valueAt({ currentValueMinor: 500_00, method: "stored" }, "2024-08-01");

    expect(result.valueMinor).toBe(500_00);
  });
});

describe("valueAt — derived (units × price)", () => {
  function buyOp(
    id: string,
    units: string,
    pricePerUnit: string,
    executedAt: string,
  ): InvestmentOperation {
    return {
      assetId: "a1",
      currency: "EUR",
      executedAt,
      feesMinor: 0,
      id,
      kind: "buy",
      pricePerUnit,
      units,
    };
  }

  const ops = [
    buyOp("op1", "10", "100", "2024-01-15"),
    buyOp("op2", "10", "150", "2024-06-15"),
  ];

  function derivedInput(operations: InvestmentOperation[]): HoldingValuationInput {
    return { assetId: "a1", currency: "EUR", method: "derived", operations };
  }

  test("is not present before its first operation", () => {
    expect(valueAt(derivedInput(ops), "2024-01-01").valueMinor).toBeNull();
  });

  test("values only the units held by the date, at the latest operation price", () => {
    const result = valueAt(derivedInput(ops), "2024-03-01");

    expect(result.valueMinor).toBe(1000_00); // 10 units × 100
    expect(result.units).toBe("10");
  });

  test("includes a later operation once the date passes it", () => {
    const result = valueAt(derivedInput(ops), "2024-07-01");

    expect(result.valueMinor).toBe(3000_00); // 20 units × latest price 150
    expect(result.units).toBe("20");
  });

  test("a captured unit price overrides the latest operation price", () => {
    const result = valueAt(
      {
        assetId: "a1",
        capturedUnitPrice: "200",
        currency: "EUR",
        method: "derived",
        operations: ops,
      },
      "2024-07-01",
    );

    expect(result.valueMinor).toBe(4000_00); // 20 units × captured 200
    expect(result.unitPrice).toBe("200");
  });

  test("is not present once fully sold by the date", () => {
    const sold = [
      ...ops,
      {
        assetId: "a1",
        currency: "EUR" as const,
        executedAt: "2024-08-01",
        feesMinor: 0,
        id: "op3",
        kind: "sell" as const,
        pricePerUnit: "150",
        units: "20",
      },
    ];

    expect(valueAt(derivedInput(sold), "2024-09-01").valueMinor).toBeNull();
  });

  test("a captured unit price does not resurrect a position before its first operation", () => {
    const result = valueAt(
      {
        assetId: "a1",
        capturedUnitPrice: "200",
        currency: "EUR",
        method: "derived",
        operations: ops,
      },
      "2024-01-01",
    );

    expect(result.valueMinor).toBeNull();
  });
});

describe("valueAt — appreciating (revaluation curve)", () => {
  test("takes a market appraisal's value on its own date (delegates to the curve)", () => {
    const result = valueAt(
      {
        anchors: [
          {
            adjustsPriorCurve: true,
            valuationDate: "2024-06-01",
            valueMinor: 250_000_00,
          },
        ],
        currentValueMinor: 300_000_00,
        method: "appreciating",
        today: "2025-01-01",
      },
      "2024-06-01",
    );

    // Not the manual current (300k) — the curve's appraisal value on its date.
    expect(result.valueMinor).toBe(250_000_00);
  });

  test("without anchors or a rate, falls back to the last known manual value", () => {
    const result = valueAt(
      {
        anchors: [],
        currentValueMinor: 300_000_00,
        method: "appreciating",
        today: "2025-01-01",
        valueHistory: [{ dateKey: "2024-01-01", valueMinor: 280_000_00 }],
      },
      "2024-08-01",
    );

    expect(result.valueMinor).toBe(280_000_00);
  });

  test("a rate-only curve (no anchors) routes to the appreciation curve, not the fallback", () => {
    const result = valueAt(
      {
        anchors: [],
        annualAppreciationRate: "0.10",
        currentValueMinor: 110_000_00,
        method: "appreciating",
        today: "2025-01-01",
      },
      "2024-01-01",
    );

    // Back-extrapolated ~one year at 10% → strictly below today's value, proving
    // the rate-only disjunct routes to the curve rather than returning
    // currentValueMinor via the manual fallback.
    expect(result.valueMinor).not.toBeNull();
    expect(result.valueMinor!).toBeLessThan(110_000_00);
  });
});

describe("valueAt — amortized (French amortization plan)", () => {
  const plan = {
    annualInterestRate: "0.03",
    initialCapitalMinor: 100_000_00,
    startDate: "2024-01-01",
    termMonths: 240,
  };

  test("equals the initial capital at the plan start date", () => {
    const result = valueAt(
      { currentBalanceMinor: 90_000_00, method: "amortized", plan },
      "2024-01-01",
    );

    expect(result.valueMinor).toBe(100_000_00);
  });

  test("has amortized below the initial capital years into the term", () => {
    const result = valueAt(
      { currentBalanceMinor: 90_000_00, method: "amortized", plan },
      "2030-01-01",
    );

    expect(result.valueMinor).toBeLessThan(100_000_00);
  });

  test("threads interest-rate revisions through to the amortization curve", () => {
    const plan = {
      annualInterestRate: "0.03",
      initialCapitalMinor: 100_000_00,
      startDate: "2024-01-01",
      termMonths: 240,
    };
    const at = "2026-06-01";

    const withoutRevision = valueAt(
      { currentBalanceMinor: 0, method: "amortized", plan },
      at,
    ).valueMinor;
    const withRevision = valueAt(
      {
        currentBalanceMinor: 0,
        method: "amortized",
        plan,
        revisions: [{ newAnnualInterestRate: "0.06", revisionDate: "2025-01-01" }],
      },
      at,
    ).valueMinor;

    // A rate hike after its revision date changes the outstanding balance — the
    // dispatcher must thread revisions into the curve, not drop them.
    expect(withRevision).not.toBe(withoutRevision);
  });

  test("threads early repayments through to the amortization curve", () => {
    const at = "2026-06-01";

    const withoutRepayment = valueAt(
      { currentBalanceMinor: 0, method: "amortized", plan },
      at,
    ).valueMinor;
    const withRepayment = valueAt(
      {
        currentBalanceMinor: 0,
        earlyRepayments: [
          { amountMinor: 10_000_00, mode: "reduce-payment", repaymentDate: "2025-01-01" },
        ],
        method: "amortized",
        plan,
      },
      at,
    ).valueMinor;

    // A lump dated before the valuation date lowers the outstanding balance —
    // the dispatcher must thread early repayments into the curve, not drop them.
    expect(withRepayment).not.toBe(withoutRepayment);
    expect(withRepayment!).toBeLessThan(withoutRepayment!);
  });
});

describe("valueAt — anchored (declared balances)", () => {
  const anchors = [
    { anchorDate: "2024-01-01", balanceMinor: 10_000_00 },
    { anchorDate: "2024-12-31", balanceMinor: 0 },
  ];

  test("a revolving balance equals the anchor on its date", () => {
    const result = valueAt(
      { anchors, currentBalanceMinor: 0, debtModel: "revolving", method: "anchored" },
      "2024-01-01",
    );

    expect(result.valueMinor).toBe(10_000_00);
  });

  test("an informal balance holds the initial capital before the first anchor", () => {
    const result = valueAt(
      {
        anchors,
        currentBalanceMinor: 0,
        debtModel: "informal",
        initialCapitalMinor: 12_000_00,
        method: "anchored",
      },
      "2023-06-01",
    );

    expect(result.valueMinor).toBe(12_000_00);
  });

  test("revolving interpolates linearly while informal steps — same anchors, divergent mid-range", () => {
    const revolving = valueAt(
      { anchors, currentBalanceMinor: 0, debtModel: "revolving", method: "anchored" },
      "2024-07-01",
    ).valueMinor;
    const informal = valueAt(
      { anchors, currentBalanceMinor: 0, debtModel: "informal", method: "anchored" },
      "2024-07-01",
    ).valueMinor;

    // Revolving interpolates strictly between the anchors; informal holds the most
    // recent anchor (a step). They diverge, proving the debtModel field is honoured.
    expect(revolving).not.toBeNull();
    expect(revolving!).toBeGreaterThan(0);
    expect(revolving!).toBeLessThan(10_000_00);
    expect(informal).toBe(10_000_00);
  });
});
