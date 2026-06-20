/**
 * Historical-price backfill PLAN (#380, ADR 0033) — the preview core.
 *
 * Given an investment's operation ledger, the dates it already has snapshots on,
 * the historical prices a source returned, and "today", produce the monthly
 * points the backfill would create/update (units × price, frozen unit price) and
 * the months it cannot price (gaps). Pure: writes nothing, reads no clock — the
 * caller passes `today`. Months without a price stay GAPS — prices are never
 * invented (the central guarantee of the issue).
 */
import { describe, expect, it } from "vitest";

import { planPriceBackfill } from "./price-backfill-plan";
import type { InvestmentOperation } from "./investment-types";

function buy(executedAt: string, units: string, price: string): InvestmentOperation {
  return {
    assetId: "btc",
    currency: "EUR",
    executedAt,
    feesMinor: 0,
    id: `op_${executedAt}`,
    kind: "buy",
    pricePerUnit: price,
    units,
  };
}

describe("planPriceBackfill (#380)", () => {
  it("generates one monthly (1st) point from the first-op month through today", () => {
    const plan = planPriceBackfill({
      operations: [buy("2026-01-15", "1", "30000")],
      existingSnapshotDates: new Set(),
      pricesByDate: new Map([
        ["2026-01-01", "30000"], // before the op → no position yet, skipped
        ["2026-02-01", "40000"],
        ["2026-03-01", "50000"],
      ]),
      source: "coingecko",
      today: "2026-03-10",
    });

    // 01-01 is before the first op (no units yet) → not a point and not a gap.
    expect(plan.points.map((p) => p.dateKey)).toEqual(["2026-02-01", "2026-03-01"]);
    expect(plan.source).toBe("coingecko");
  });

  it("stores coherent units, unit price, and value per point (units × price)", () => {
    const plan = planPriceBackfill({
      operations: [buy("2026-01-15", "0.5", "30000")],
      existingSnapshotDates: new Set(),
      pricesByDate: new Map([["2026-02-01", "40000"]]),
      source: "coingecko",
      today: "2026-02-10",
    });

    expect(plan.points).toEqual([
      {
        action: "create",
        dateKey: "2026-02-01",
        units: "0.5",
        unitPriceDecimal: "40000",
        valueMinor: 0.5 * 40000 * 100,
      },
    ]);
  });

  it("marks an existing snapshot date as update, a missing one as create", () => {
    const plan = planPriceBackfill({
      operations: [buy("2026-01-15", "1", "30000")],
      existingSnapshotDates: new Set(["2026-02-01"]),
      pricesByDate: new Map([
        ["2026-02-01", "40000"],
        ["2026-03-01", "50000"],
      ]),
      source: "coingecko",
      today: "2026-03-10",
    });

    const byDate = new Map(plan.points.map((p) => [p.dateKey, p.action]));
    expect(byDate.get("2026-02-01")).toBe("update");
    expect(byDate.get("2026-03-01")).toBe("create");
  });

  it("records a GAP for a month with no price, and never invents a price", () => {
    const plan = planPriceBackfill({
      operations: [buy("2026-01-15", "1", "30000")],
      existingSnapshotDates: new Set(),
      pricesByDate: new Map([
        ["2026-02-01", "40000"],
        // 2026-03-01 is missing → a gap, not a fabricated point.
      ]),
      source: "coingecko",
      today: "2026-03-10",
    });

    expect(plan.points.map((p) => p.dateKey)).toEqual(["2026-02-01"]);
    expect(plan.gaps).toEqual(["2026-03-01"]);
  });

  it("skips months before the first operation entirely (neither point nor gap)", () => {
    const plan = planPriceBackfill({
      operations: [buy("2026-03-10", "1", "30000")],
      existingSnapshotDates: new Set(),
      pricesByDate: new Map([
        ["2026-01-01", "20000"],
        ["2026-02-01", "25000"],
        ["2026-04-01", "30000"],
      ]),
      source: "coingecko",
      today: "2026-04-10",
    });

    // Only 04-01 has a position (op on 03-10); 03-01 is before the op so it is
    // skipped, not a gap. 01/02 are before the op too.
    expect(plan.points.map((p) => p.dateKey)).toEqual(["2026-04-01"]);
    expect(plan.gaps).toEqual([]);
  });

  it("excludes months after the position was fully sold (no units held)", () => {
    const plan = planPriceBackfill({
      operations: [
        buy("2026-01-15", "1", "30000"),
        {
          assetId: "btc",
          currency: "EUR",
          executedAt: "2026-02-20",
          feesMinor: 0,
          id: "sell",
          kind: "sell",
          pricePerUnit: "40000",
          units: "1",
        },
      ],
      existingSnapshotDates: new Set(),
      pricesByDate: new Map([
        ["2026-02-01", "40000"], // 1 unit held
        ["2026-03-01", "50000"], // fully sold by 02-20 → no units, skip
      ]),
      source: "coingecko",
      today: "2026-03-10",
    });

    expect(plan.points.map((p) => p.dateKey)).toEqual(["2026-02-01"]);
    // 03-01 has no position → skipped, NOT a gap (we never had units to value).
    expect(plan.gaps).toEqual([]);
  });

  it("includes today's month when the 1st is on or before today", () => {
    const plan = planPriceBackfill({
      operations: [buy("2026-01-15", "1", "30000")],
      existingSnapshotDates: new Set(),
      pricesByDate: new Map([
        ["2026-01-01", "30000"],
        ["2026-02-01", "40000"],
      ]),
      source: "coingecko",
      today: "2026-02-01", // the 1st itself is today → included
    });

    expect(plan.points.map((p) => p.dateKey)).toContain("2026-02-01");
  });
});
