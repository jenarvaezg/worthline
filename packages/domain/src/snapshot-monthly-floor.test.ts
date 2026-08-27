/**
 * The monthly floor of the pre-signup history (#1444).
 */

import { describe, expect, it } from "vitest";
import type { InvestmentOperation } from "./investment-types";
import { monthlyFloorDateKeys } from "./snapshot-monthly-floor";

function buy(executedAt: string, units: string, assetId = "fund"): InvestmentOperation {
  return {
    assetId,
    currency: "EUR",
    executedAt,
    feesMinor: 0,
    id: `buy_${assetId}_${executedAt}_${units}`,
    kind: "buy",
    pricePerUnit: "100",
    units,
  };
}

function sell(executedAt: string, units: string, assetId = "fund"): InvestmentOperation {
  return {
    ...buy(executedAt, units, assetId),
    id: `sell_${assetId}_${executedAt}`,
    kind: "sell",
  };
}

function ledger(
  ...operations: InvestmentOperation[]
): Map<string, InvestmentOperation[]> {
  const byAsset = new Map<string, InvestmentOperation[]>();
  for (const operation of operations) {
    const existing = byAsset.get(operation.assetId) ?? [];
    existing.push(operation);
    byAsset.set(operation.assetId, existing);
  }
  return byAsset;
}

describe("monthlyFloorDateKeys", () => {
  it("yields the 1st of every month the position existed on", () => {
    const dates = monthlyFloorDateKeys({
      operationsByAsset: ledger(buy("2026-01-10", "10")),
      today: "2026-04-15",
    });

    // January's 1st predates the buy; from February on the position was there.
    expect(dates).toEqual(["2026-02-01", "2026-03-01", "2026-04-01"]);
  });

  it("stops before today — the daily capture owns today", () => {
    const dates = monthlyFloorDateKeys({
      operationsByAsset: ledger(buy("2026-01-10", "10")),
      today: "2026-03-01",
    });

    expect(dates).toEqual(["2026-02-01"]);
  });

  it("invents no month once everything is sold", () => {
    const dates = monthlyFloorDateKeys({
      operationsByAsset: ledger(buy("2026-01-10", "10"), sell("2026-02-20", "10")),
      today: "2026-05-15",
    });

    expect(dates).toEqual(["2026-02-01"]);
  });

  it("counts a month where ANY investment still holds units", () => {
    const dates = monthlyFloorDateKeys({
      operationsByAsset: ledger(
        buy("2026-01-10", "10", "a"),
        sell("2026-02-20", "10", "a"),
        buy("2026-03-05", "5", "b"),
      ),
      today: "2026-05-15",
    });

    expect(dates).toEqual(["2026-02-01", "2026-04-01", "2026-05-01"]);
  });

  it("is empty with no operations, and with only future ones", () => {
    expect(
      monthlyFloorDateKeys({ operationsByAsset: new Map(), today: "2026-05-15" }),
    ).toEqual([]);
    expect(
      monthlyFloorDateKeys({
        operationsByAsset: ledger(buy("2026-09-01", "10")),
        today: "2026-05-15",
      }),
    ).toEqual([]);
  });
});
