import { describe, expect, it } from "vitest";

import type { InvestmentOperation } from "./investment-types";
import { measureMonthlySavings, suggestMonthlySavingsCapacity } from "./monthly-savings";

/**
 * Build an investment operation. `amount` is the gross trade value in major
 * units (e.g. 1000 → 1000 € of units at 1 €/unit), so a test reads as "a 1000 €
 * buy on this date" without unit/price bookkeeping noise.
 */
function op(
  kind: "buy" | "sell",
  executedAt: string,
  amountMajor: number,
  feesMinor = 0,
): InvestmentOperation {
  return {
    id: `${kind}-${executedAt}`,
    assetId: "asset-1",
    kind,
    executedAt,
    units: String(amountMajor),
    pricePerUnit: "1",
    currency: "EUR",
    feesMinor,
  };
}

describe("suggestMonthlySavingsCapacity", () => {
  it("reports insufficient_data when there are no operations", () => {
    expect(suggestMonthlySavingsCapacity([])).toEqual({
      amountMinor: 0,
      monthsCovered: 0,
      basis: "insufficient_data",
    });
  });

  it("averages steady monthly buys over the months they span", () => {
    const operations = Array.from({ length: 12 }, (_, i) =>
      op("buy", `2025-${String(i + 1).padStart(2, "0")}-15`, 1000),
    );

    expect(suggestMonthlySavingsCapacity(operations)).toEqual({
      amountMinor: 100_000, // 1000 € / month
      monthsCovered: 12,
      basis: "operations",
    });
  });

  it("counts a buy's fees as money saved (cost out of pocket)", () => {
    expect(suggestMonthlySavingsCapacity([op("buy", "2025-01-10", 1000, 500)])).toEqual({
      amountMinor: 100_500, // 1000 € + 5 € fees, over 1 month
      monthsCovered: 1,
      basis: "operations",
    });
  });

  it("treats sells as withdrawn money, netting them against buys", () => {
    const operations = [op("buy", "2025-01-10", 1000), op("sell", "2025-02-10", 500)];

    // net 500 € invested over 2 months → 250 €/month
    expect(suggestMonthlySavingsCapacity(operations)).toEqual({
      amountMinor: 25_000,
      monthsCovered: 2,
      basis: "operations",
    });
  });

  it("floors a net-negative history at zero (you are dis-saving, not saving)", () => {
    const operations = [op("buy", "2025-01-10", 100), op("sell", "2025-02-10", 1000)];

    expect(suggestMonthlySavingsCapacity(operations)).toEqual({
      amountMinor: 0,
      monthsCovered: 2,
      basis: "operations",
    });
  });

  it("spans whole calendar months across a year boundary", () => {
    // Nov 2024, Dec, Jan, Feb 2025 = 4 calendar months inclusive
    const operations = [op("buy", "2024-11-20", 400), op("buy", "2025-02-05", 400)];

    expect(suggestMonthlySavingsCapacity(operations)).toEqual({
      amountMinor: 20_000, // 800 € / 4 months
      monthsCovered: 4,
      basis: "operations",
    });
  });

  it("uses a one-month span when all operations fall in the same month", () => {
    const operations = [op("buy", "2025-06-01", 300), op("buy", "2025-06-28", 300)];

    expect(suggestMonthlySavingsCapacity(operations)).toEqual({
      amountMinor: 60_000, // 600 € in a single month
      monthsCovered: 1,
      basis: "operations",
    });
  });
});

describe("measureMonthlySavings (#1449)", () => {
  it("reports insufficient_data when the ledger is empty", () => {
    expect(measureMonthlySavings([], { asOfDateKey: "2026-08-18" })).toMatchObject({
      amountMinor: 0,
      basis: "insufficient_data",
      monthsCovered: 0,
      operationsCount: 0,
    });
  });

  it("keeps the sign: a net-negative window measures dis-saving", () => {
    const operations = [op("buy", "2026-01-10", 100), op("sell", "2026-02-10", 1300)];

    // net −1200 € over Aug-2025..Aug-2026, ledger starts 2026-01 → 8 months
    expect(
      measureMonthlySavings(operations, { asOfDateKey: "2026-08-18" }),
    ).toMatchObject({ amountMinor: -15_000, basis: "operations", monthsCovered: 8 });
  });

  it("divides by the months elapsed since the ledger opened, not between operations", () => {
    // A single 1.000 € buy six months ago is 1.000 € spread over six months of
    // living, not 1.000 €/month: the suggestion's span-between-operations rule
    // would read it as 1.000 €/month.
    const operations = [op("buy", "2026-03-01", 1000)];

    expect(
      measureMonthlySavings(operations, { asOfDateKey: "2026-08-18" }),
    ).toMatchObject({ amountMinor: 16_667, monthsCovered: 6 });
  });

  it("ignores operations older than the window but still counts its months", () => {
    const operations = [
      op("buy", "2023-05-10", 50_000), // way outside the 12-month window
      op("buy", "2026-08-01", 600),
    ];

    expect(
      measureMonthlySavings(operations, { asOfDateKey: "2026-08-18" }),
    ).toMatchObject({ amountMinor: 5000, monthsCovered: 12, operationsCount: 1 });
  });

  it("measures a dormant-but-old ledger as zero saved, not as no data", () => {
    const operations = [op("buy", "2023-05-10", 50_000)];

    expect(
      measureMonthlySavings(operations, { asOfDateKey: "2026-08-18" }),
    ).toMatchObject({
      amountMinor: 0,
      basis: "operations",
      monthsCovered: 12,
      operationsCount: 0,
    });
  });

  it("reports the window it measured, so a consumer can name it", () => {
    expect(
      measureMonthlySavings([op("buy", "2026-08-01", 600)], {
        asOfDateKey: "2026-08-18",
      }),
    ).toMatchObject({ windowStartMonthKey: "2025-09", windowEndMonthKey: "2026-08" });
  });

  it("skips operations in another currency and says how many", () => {
    const dollars: InvestmentOperation = {
      ...op("buy", "2026-07-10", 1000),
      id: "usd-buy",
      currency: "USD",
    };
    const operations = [op("buy", "2026-07-10", 600), dollars];

    expect(
      measureMonthlySavings(operations, { asOfDateKey: "2026-08-18", currency: "EUR" }),
    ).toMatchObject({
      amountMinor: 30_000, // only the 600 € buy, over 2 months
      operationsCount: 1,
      skippedForeignCount: 1,
    });
  });

  it("counts every currency when the caller names none (the suggestion's behaviour)", () => {
    const dollars: InvestmentOperation = {
      ...op("buy", "2026-07-10", 1000),
      id: "usd-buy",
      currency: "USD",
    };

    expect(measureMonthlySavings([dollars], { asOfDateKey: "2026-08-18" })).toMatchObject(
      { operationsCount: 1, skippedForeignCount: 0 },
    );
  });

  it("honours a narrower window when asked", () => {
    const operations = [op("buy", "2026-01-10", 1000), op("buy", "2026-08-10", 300)];

    expect(
      measureMonthlySavings(operations, { asOfDateKey: "2026-08-18", windowMonths: 3 }),
    ).toMatchObject({ amountMinor: 10_000, monthsCovered: 3, operationsCount: 1 });
  });
});
