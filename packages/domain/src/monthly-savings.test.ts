import { describe, expect, it } from "vitest";

import type { InvestmentOperation } from "./investment-types";
import { suggestMonthlySavingsCapacity } from "./monthly-savings";

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
