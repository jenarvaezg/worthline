/**
 * The careo of ONE holding before MyInvestor replaces its manual operations (#1881,
 * design C): exact pairing by day, amount and units, the cost before and after from
 * worthline's own fold, and what linking does to its contribution plan — from the
 * same function the command applies (ADR 0115 decision 5).
 */
import type { InvestmentOperation, PlannedContribution } from "@worthline/domain";
import { describe, expect, test } from "vitest";

import { myInvestorCareo, myInvestorNamesAlike } from "./myinvestor-careo";

const TODAY = "2026-11-04";

function buy(
  id: string,
  executedAt: string,
  units: string,
  pricePerUnit: string,
): InvestmentOperation {
  return {
    assetId: "a",
    currency: "EUR",
    executedAt,
    feesMinor: 0,
    id,
    kind: "buy",
    pricePerUnit,
    units,
  };
}

const MANUAL = [
  buy("m1", "2024-03-05", "3.1307", "32.37"),
  buy("m2", "2024-09-06", "6.9413", "36.17"),
  buy("m3", "2025-01-10", "1.2071", "41.53"),
];
const SOURCE = [
  buy("s1", "2024-03-05", "3.1307", "32.37"),
  buy("s2", "2024-09-05", "6.9413", "36.17"),
  buy("s3", "2025-06-05", "2.4391", "41.11"),
];

describe("myInvestorCareo", () => {
  test("pairs exactly by day, amount and units; the rest leaves or enters", () => {
    const careo = myInvestorCareo({
      manual: MANUAL,
      plan: null,
      source: SOURCE,
      today: TODAY,
    });

    expect(careo.counts).toEqual({ enters: 2, leaves: 2, manual: 3, same: 1 });
    expect(careo.rows.map((row) => [row.date, row.mark])).toEqual([
      ["2024-03-05", "same"],
      ["2024-09-05", "enters"],
      ["2024-09-06", "leaves"],
      ["2025-01-10", "leaves"],
      ["2025-06-05", "enters"],
    ]);
  });

  test("a leaving and an entering row alike but for a near day only carry a hint", () => {
    const careo = myInvestorCareo({
      manual: MANUAL,
      plan: null,
      source: SOURCE,
      today: TODAY,
    });

    const hinted = careo.rows.filter((row) => row.near !== null);
    expect(hinted.map((row) => [row.date, row.mark, row.near])).toEqual([
      ["2024-09-05", "enters", "2024-09-06"],
      ["2024-09-06", "leaves", "2024-09-05"],
    ]);
    // Never paired: the hint informs, the marks stay what the exact rule says.
    expect(careo.counts.same).toBe(1);
  });

  test("the cost before and after is worthline's moving average of each ledger", () => {
    const careo = myInvestorCareo({
      manual: MANUAL,
      plan: null,
      source: SOURCE,
      today: TODAY,
    });

    // 3.1307 × 32.37 + 6.9413 × 36.17 + 1.2071 × 41.53 = 101.34 + 251.07 + 50.13;
    // 402.54 / 11.2791 = 35.69
    expect(careo.before).toEqual({
      averageMinor: 3_569,
      costMinor: 40_254,
      units: "11.2791",
    });
    // 101.34 + 251.07 + 2.4391 × 41.11 (100.27); 452.68 / 12.5111 = 36.18
    expect(careo.after).toEqual({
      averageMinor: 3_618,
      costMinor: 45_268,
      units: "12.5111",
    });
    // Without a price the holding is valued at cost: the difference is the cost's.
    expect(careo.valueDeltaMinor).toBe(45_268 - 40_254);
  });

  test("a hand-set price values both ledgers too, as the holding's valuation does", () => {
    const careo = myInvestorCareo({
      manual: MANUAL,
      manualPrice: "43.07",
      plan: null,
      source: SOURCE,
      today: TODAY,
    });

    expect(careo.valueDeltaMinor).toBe(53_885 - 48_579);
  });

  test("with a price, the value difference is the units' difference at that price", () => {
    const careo = myInvestorCareo({
      manual: MANUAL,
      plan: null,
      cachedPrice: "43.07",
      source: SOURCE,
      today: TODAY,
    });

    // (12.5111 − 11.2791) × 43.07 = 538.85 − 485.79
    expect(careo.valueDeltaMinor).toBe(53_885 - 48_579);
  });

  test("the plan lines that close today and the pending occurrences that go", () => {
    const line: PlannedContribution = {
      amount: { mode: "money", value: 10_037 },
      cadence: { dayOfMonth: 5, kind: "monthly" },
      destinationHoldingId: "a",
      id: "c1",
      startDate: "2026-08-05",
    };
    const careo = myInvestorCareo({
      manual: MANUAL,
      plan: {
        contributions: [line],
        reconciliations: [
          { occurrenceId: "c1:2026-08-05", operationIds: [], state: "fulfilled" },
        ],
      },
      source: SOURCE,
      today: TODAY,
    });

    expect(careo.plan).toEqual({
      lines: [{ amount: line.amount, cadence: line.cadence }],
      pending: 2,
    });
  });

  test("no plan, or a plan with nothing running, says nothing", () => {
    expect(
      myInvestorCareo({
        manual: [],
        plan: { contributions: [], reconciliations: [] },
        source: SOURCE,
        today: TODAY,
      }).plan,
    ).toBeNull();
  });
});

describe("myInvestorNamesAlike", () => {
  test("two names that share their distinctive words are alike", () => {
    expect(
      myInvestorNamesAlike(
        "Fidelity MSCI World Index Fund EUR P Acc",
        "Fidelity World (a mano, sin ISIN)",
      ),
    ).toBe(true);
    expect(myInvestorNamesAlike("Plan Indexado Global, PP", "indexado global")).toBe(
      true,
    );
  });

  test("the generic words of a fund's name never make two alike", () => {
    expect(
      myInvestorNamesAlike(
        "Vanguard Global Stock Index Fund EUR Acc",
        "Amundi Index Fund EUR Acc",
      ),
    ).toBe(false);
    expect(myInvestorNamesAlike("Fidelity World", "Vanguard World")).toBe(false);
  });
});
