import { describe, expect, test } from "vitest";

import {
  assertContributionAllowanceInput,
  type ContributionAllowance,
  computeContributionAllowanceUsage,
} from "./contribution-allowance";
import type { InvestmentOperation } from "./investment-types";

const allowance: ContributionAllowance = {
  id: "cupo-1",
  scopeId: "jorge",
  label: "Planes de pensiones",
  annualCapMinor: 150_000,
  holdingIds: ["pp-myinvestor"],
};

function buy(
  overrides: Partial<InvestmentOperation> &
    Pick<InvestmentOperation, "id" | "executedAt">,
): InvestmentOperation {
  return {
    assetId: "pp-myinvestor",
    currency: "EUR",
    feesMinor: 0,
    kind: "buy",
    pricePerUnit: "10",
    units: "10",
    ...overrides,
  };
}

describe("computeContributionAllowanceUsage", () => {
  test("counts real buy operations of the calendar year against the cap", () => {
    const usage = computeContributionAllowanceUsage({
      allowance,
      currency: "EUR",
      operations: [
        buy({ executedAt: "2026-02-10", id: "op-1", pricePerUnit: "10", units: "80" }),
        buy({ executedAt: "2026-07-01", id: "op-2", pricePerUnit: "10", units: "50" }),
      ],
      todayISO: "2026-08-19",
    });

    expect(usage.year).toBe(2026);
    expect(usage.capMinor).toBe(150_000);
    expect(usage.consumedMinor).toBe(130_000);
    expect(usage.remainingMinor).toBe(20_000);
    expect(usage.exceeded).toBe(false);
    expect(usage.consumedRatio).toBeCloseTo(130_000 / 150_000, 10);
  });

  test("a buy consumes its fees too — money out of pocket is what enters the plan", () => {
    const usage = computeContributionAllowanceUsage({
      allowance,
      currency: "EUR",
      operations: [
        buy({
          executedAt: "2026-02-10",
          feesMinor: 500,
          pricePerUnit: "10",
          units: "10",
          id: "op-1",
        }),
      ],
      todayISO: "2026-08-19",
    });

    expect(usage.consumedMinor).toBe(10_500);
  });

  test("ignores operations outside the calendar year of `todayISO`", () => {
    const usage = computeContributionAllowanceUsage({
      allowance,
      currency: "EUR",
      operations: [
        buy({
          executedAt: "2025-12-31",
          id: "op-last-year",
          pricePerUnit: "10",
          units: "100",
        }),
        buy({
          executedAt: "2027-01-01",
          id: "op-next-year",
          pricePerUnit: "10",
          units: "100",
        }),
        buy({ executedAt: "2026-01-01", id: "op-in", pricePerUnit: "10", units: "30" }),
      ],
      todayISO: "2026-08-19",
    });

    expect(usage.consumedMinor).toBe(30_000);
    expect(usage.entries.map((entry) => entry.operationId)).toEqual(["op-in"]);
  });

  test("ignores holdings that do not consume this allowance", () => {
    const usage = computeContributionAllowanceUsage({
      allowance,
      currency: "EUR",
      operations: [
        buy({
          assetId: "fondo-indexado",
          executedAt: "2026-03-01",
          id: "op-other",
          units: "100",
        }),
        buy({ executedAt: "2026-03-02", id: "op-mine", units: "20" }),
      ],
      todayISO: "2026-08-19",
    });

    expect(usage.consumedMinor).toBe(20_000);
  });

  test("a sell does not give contribution room back", () => {
    const usage = computeContributionAllowanceUsage({
      allowance,
      currency: "EUR",
      operations: [
        buy({ executedAt: "2026-03-01", id: "op-buy", units: "100" }),
        buy({ executedAt: "2026-04-01", id: "op-sell", kind: "sell", units: "60" }),
      ],
      todayISO: "2026-08-19",
    });

    expect(usage.consumedMinor).toBe(100_000);
    expect(usage.entries.map((entry) => entry.operationId)).toEqual(["op-buy"]);
  });

  test("reports an exceeded allowance with a negative remainder", () => {
    const usage = computeContributionAllowanceUsage({
      allowance,
      currency: "EUR",
      operations: [buy({ executedAt: "2026-03-01", id: "op-1", units: "180" })],
      todayISO: "2026-08-19",
    });

    expect(usage.consumedMinor).toBe(180_000);
    expect(usage.remainingMinor).toBe(-30_000);
    expect(usage.exceeded).toBe(true);
    expect(usage.consumedRatio).toBeCloseTo(1.2, 10);
  });

  test("counts, never sums, an operation denominated in another currency (#1401)", () => {
    const usage = computeContributionAllowanceUsage({
      allowance,
      currency: "EUR",
      operations: [
        buy({ currency: "USD", executedAt: "2026-03-01", id: "op-usd", units: "100" }),
        buy({ executedAt: "2026-03-02", id: "op-eur", units: "20" }),
      ],
      todayISO: "2026-08-19",
    });

    expect(usage.consumedMinor).toBe(20_000);
    expect(usage.skippedForeignCount).toBe(1);
  });

  test("an allowance with no entries this year reads 0 consumed, not 'no data'", () => {
    const usage = computeContributionAllowanceUsage({
      allowance,
      currency: "EUR",
      operations: [],
      todayISO: "2026-08-19",
    });

    expect(usage.consumedMinor).toBe(0);
    expect(usage.remainingMinor).toBe(150_000);
    expect(usage.consumedRatio).toBe(0);
    expect(usage.entries).toEqual([]);
  });

  test("lists its entries most recent first, so the figure can be audited (#1426)", () => {
    const usage = computeContributionAllowanceUsage({
      allowance,
      currency: "EUR",
      operations: [
        buy({ executedAt: "2026-01-15", id: "op-a", units: "10" }),
        buy({ executedAt: "2026-06-15", id: "op-b", units: "20" }),
        buy({ executedAt: "2026-03-15", id: "op-c", units: "30" }),
      ],
      todayISO: "2026-08-19",
    });

    expect(usage.entries).toEqual([
      {
        amountMinor: 20_000,
        dateISO: "2026-06-15",
        holdingId: "pp-myinvestor",
        operationId: "op-b",
      },
      {
        amountMinor: 30_000,
        dateISO: "2026-03-15",
        holdingId: "pp-myinvestor",
        operationId: "op-c",
      },
      {
        amountMinor: 10_000,
        dateISO: "2026-01-15",
        holdingId: "pp-myinvestor",
        operationId: "op-a",
      },
    ]);
  });

  test("aggregates every marked holding — the cap is the contributor's, not one plan's", () => {
    const usage = computeContributionAllowanceUsage({
      allowance: { ...allowance, holdingIds: ["pp-myinvestor", "pp-empresa"] },
      currency: "EUR",
      operations: [
        buy({ executedAt: "2026-03-01", id: "op-1", units: "80" }),
        buy({ assetId: "pp-empresa", executedAt: "2026-04-01", id: "op-2", units: "50" }),
      ],
      todayISO: "2026-08-19",
    });

    expect(usage.consumedMinor).toBe(130_000);
  });

  test("the declared currency is required — there is no «sum it all as given» mode", () => {
    // #1401: sumar dólares como euros fue el bug. Un modo por defecto que sumase
    // todo tal cual sería ese mismo bug detrás de un parámetro opcional.
    const usage = computeContributionAllowanceUsage({
      allowance,
      currency: "EUR",
      operations: [
        buy({ currency: "USD", executedAt: "2026-03-01", id: "op-usd", units: "20" }),
      ],
      todayISO: "2026-08-19",
    });

    expect(usage.consumedMinor).toBe(0);
    expect(usage.skippedForeignCount).toBe(1);
  });
});

describe("computeContributionAllowanceUsage — una apertura no es una aportación (#1567)", () => {
  test("dar de alta un plan que ya existía deja el cupo del año intacto", () => {
    // The measured case of #1504: 20.000 € typed in August as «sé cuánto tengo hoy»
    // landed as a buy dated that day and ate the year's ceiling. An apertura declares
    // pre-existing wealth, not money put in this year.
    const usage = computeContributionAllowanceUsage({
      allowance,
      currency: "EUR",
      operations: [
        buy({
          executedAt: "2026-08-19",
          id: "op-opening",
          pricePerUnit: "10",
          source: "opening",
          units: "2000",
        }),
        buy({ executedAt: "2026-02-10", id: "op-real", pricePerUnit: "10", units: "50" }),
      ],
      todayISO: "2026-08-19",
    });

    expect(usage.consumedMinor).toBe(50_000);
    expect(usage.entries.map((entry) => entry.operationId)).toEqual(["op-real"]);
  });
});

describe("computeContributionAllowanceUsage — el traspaso no aporta (#1393)", () => {
  test("la pata receptora de un traspaso no consume cupo", () => {
    // Jorge's counter read «3.627 € de 1.500 — te has pasado 2.127 €» because three
    // of the eleven buys it counted were the receiving legs of traspasos between
    // pension plans. Moving a plan to another manager is not a contribution; this
    // test is here so nobody "fixes" the counter later by adding them back.
    const usage = computeContributionAllowanceUsage({
      allowance,
      currency: "EUR",
      operations: [
        buy({ executedAt: "2026-02-10", id: "op-real", pricePerUnit: "10", units: "50" }),
        buy({
          executedAt: "2026-03-01",
          id: "op-traspaso",
          kind: "transfer_in",
          pricePerUnit: "10",
          transferCostMinor: 60_000,
          transferId: "trf_1",
          units: "83.689",
        }),
      ],
      todayISO: "2026-08-19",
    });

    expect(usage.consumedMinor).toBe(50_000);
    expect(usage.entries).toHaveLength(1);
    expect(usage.entries[0]?.operationId).toBe("op-real");
  });
});

describe("assertContributionAllowanceInput", () => {
  test("accepts a labelled cap with at least one destination", () => {
    expect(() =>
      assertContributionAllowanceInput({
        annualCapMinor: 150_000,
        holdingIds: ["pp-myinvestor"],
        label: "Planes de pensiones",
      }),
    ).not.toThrow();
  });

  test("rejects an empty label", () => {
    expect(() =>
      assertContributionAllowanceInput({
        annualCapMinor: 150_000,
        holdingIds: ["pp-myinvestor"],
        label: "  ",
      }),
    ).toThrow(/nombre/i);
  });

  test("rejects a non-positive cap", () => {
    expect(() =>
      assertContributionAllowanceInput({
        annualCapMinor: 0,
        holdingIds: ["pp-myinvestor"],
        label: "Planes de pensiones",
      }),
    ).toThrow(/tope/i);
  });

  test("rejects a cupo with no destination — it would count nothing and read as 0", () => {
    expect(() =>
      assertContributionAllowanceInput({
        annualCapMinor: 150_000,
        holdingIds: [],
        label: "Planes de pensiones",
      }),
    ).toThrow(/plan de pensiones/i);
  });
});
