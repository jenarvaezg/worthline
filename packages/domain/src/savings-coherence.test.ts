import { describe, expect, it } from "vitest";

import type { FireScopeConfig } from "./fire";
import type { InvestmentOperation } from "./investment-types";
import { assessSavingsCoherence } from "./savings-coherence";

const TODAY = "2026-08-18";

function config(overrides: Partial<FireScopeConfig> = {}): FireScopeConfig {
  return {
    monthlySpendingMinor: 200_000,
    safeWithdrawalRate: 0.04,
    ...overrides,
  };
}

/** A buy/sell of `amountMajor` € on `executedAt`, at 1 €/unit. */
function op(
  kind: "buy" | "sell",
  executedAt: string,
  amountMajor: number,
  currency = "EUR",
): InvestmentOperation {
  return {
    id: `${kind}-${executedAt}-${amountMajor}`,
    assetId: "asset-1",
    kind,
    executedAt,
    units: String(amountMajor),
    pricePerUnit: "1",
    currency: currency as InvestmentOperation["currency"],
    feesMinor: 0,
  };
}

/** One buy per month, `amountMajor` € each, for the 12 months ending 2026-08. */
function monthlyBuys(amountMajor: number): InvestmentOperation[] {
  const months = [
    "2025-09",
    "2025-10",
    "2025-11",
    "2025-12",
    "2026-01",
    "2026-02",
    "2026-03",
    "2026-04",
    "2026-05",
    "2026-06",
    "2026-07",
    "2026-08",
  ];
  return months.map((month) => op("buy", `${month}-10`, amountMajor));
}

function assess(
  operations: readonly InvestmentOperation[],
  scopeConfig: FireScopeConfig,
) {
  return assessSavingsCoherence({
    asOfDateKey: TODAY,
    config: scopeConfig,
    currency: "EUR",
    operations,
  });
}

describe("assessSavingsCoherence (#1449)", () => {
  it("stays silent when there is no ledger to measure against", () => {
    const coherence = assess([], config({ monthlySavingsCapacityMinor: 150_000 }));

    expect(coherence.state).toBe("insufficient_data");
    expect(coherence.vetoesAchievement).toBe(false);
  });

  it("stays silent with fewer months than the minimum evidence window", () => {
    const operations = [op("buy", "2026-07-10", 100), op("buy", "2026-08-10", 100)];

    expect(
      assess(operations, config({ monthlySavingsCapacityMinor: 150_000 })).state,
    ).toBe("insufficient_data");
  });

  it("stays silent when part of the window is denominated elsewhere", () => {
    const operations = [...monthlyBuys(100), op("buy", "2026-06-10", 1000, "USD")];

    expect(
      assess(operations, config({ monthlySavingsCapacityMinor: 150_000 })).state,
    ).toBe("insufficient_data");
  });

  it("reads Jorge's case as diverged, with both figures and the gap", () => {
    // Declared 1.500 €/month against a ledger that measures ~120 €/month.
    const coherence = assess(
      monthlyBuys(120),
      config({ monthlySavingsCapacityMinor: 150_000 }),
    );

    expect(coherence).toMatchObject({
      declaredMinor: 150_000,
      gapMinor: 138_000,
      measuredMinor: 12_000,
      state: "diverged",
      vetoesAchievement: false,
    });
  });

  it("accepts a small absolute difference as aligned", () => {
    // Declared 2.000 €/month, measured 1.950 € — 50 € is not news.
    const coherence = assess(
      monthlyBuys(1950),
      config({ monthlySavingsCapacityMinor: 200_000 }),
    );

    expect(coherence.state).toBe("aligned");
  });

  it("accepts a proportionally small difference as aligned", () => {
    // Declared 2.000 €/month, measured 1.900 € — 100 € absolute, 5 % relative.
    expect(
      assess(monthlyBuys(1900), config({ monthlySavingsCapacityMinor: 200_000 })).state,
    ).toBe("aligned");
  });

  it("flags a declared figure against an undeclared one, projected as zero", () => {
    // No declared capacity: the FIRE projection assumes 0 while the ledger
    // measures 600 €/month going in (#1416 — the scalar is all there is).
    const coherence = assess(monthlyBuys(600), config());

    expect(coherence).toMatchObject({
      declaredMinor: 0,
      gapMinor: -60_000,
      measuredMinor: 60_000,
      state: "diverged",
    });
  });

  it("vetoes achievement badges when the measured savings are negative", () => {
    const operations = [...monthlyBuys(100), op("sell", "2026-05-10", 5000)];

    const coherence = assess(
      operations,
      config({ monthlySavingsCapacityMinor: 100_000 }),
    );

    expect(coherence.measuredMinor).toBeLessThan(0);
    expect(coherence.vetoesAchievement).toBe(true);
    expect(coherence.state).toBe("diverged");
  });

  it("does not veto on a flat zero — dis-saving is negative, not idle", () => {
    const operations = [op("buy", "2025-01-10", 1000), op("sell", "2025-02-10", 1000)];

    const coherence = assess(operations, config({ monthlySavingsCapacityMinor: 0 }));

    expect(coherence.measuredMinor).toBe(0);
    expect(coherence.vetoesAchievement).toBe(false);
    expect(coherence.state).toBe("aligned");
  });

  it("never vetoes on evidence it just called insufficient", () => {
    // A single big sell two months ago measures negative, but two months is not
    // a habit — the badge stands.
    const coherence = assess(
      [op("buy", "2026-07-10", 100), op("sell", "2026-08-10", 5000)],
      config({ monthlySavingsCapacityMinor: 100_000 }),
    );

    expect(coherence.measuredMinor).toBeLessThan(0);
    expect(coherence.vetoesAchievement).toBe(false);
    expect(coherence.state).toBe("insufficient_data");
  });
});
