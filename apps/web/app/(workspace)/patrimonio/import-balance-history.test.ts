import { describe, expect, test } from "vitest";

import {
  BALANCE_HISTORY_MESSAGES,
  type BalanceHistoryDebtContext,
  composeBalanceHistoryRebaselines,
  parseBalanceHistoryRows,
  planBalanceHistoryImport,
  previewBalanceHistoryImport,
} from "./import-balance-history";

const TODAY = "2026-07-02";

const PLAN_CTX: BalanceHistoryDebtContext = {
  balanceRebaselines: [],
  currentBalanceMinor: 150_000_00,
  plan: {
    annualInterestRate: "0.03",
    disbursementDate: "2026-01-15",
    firstPaymentDate: "2026-02-15",
    initialCapitalMinor: 150_000_00,
    termMonths: 240,
  },
  revisions: [],
  today: TODAY,
};

describe("previewBalanceHistoryImport — per-row validation and drift (#696)", () => {
  test("accepts valid rows with drift computed vs the curve", () => {
    const preview = previewBalanceHistoryImport(
      [{ balanceMinor: 140_000_00, date: "2026-06-15" }],
      PLAN_CTX,
    );
    expect(preview).toHaveLength(1);
    expect(preview[0]).toMatchObject({
      date: "2026-06-15",
      driftMinor: expect.any(Number),
      status: "accepted",
    });
    expect(preview[0]!.driftMinor).not.toBe(0);
  });

  test("excludes non-positive balance with Spanish reason", () => {
    const preview = previewBalanceHistoryImport(
      [{ balanceMinor: 0, date: "2026-06-15" }],
      PLAN_CTX,
    );
    expect(preview[0]).toEqual({
      balanceMinor: 0,
      date: "2026-06-15",
      driftMinor: null,
      reason: BALANCE_HISTORY_MESSAGES.nonPositiveBalance,
      status: "excluded",
    });
  });

  test("excludes future dates", () => {
    const preview = previewBalanceHistoryImport(
      [{ balanceMinor: 100_000_00, date: "2026-07-03" }],
      PLAN_CTX,
    );
    expect(preview[0]?.reason).toBe(BALANCE_HISTORY_MESSAGES.futureDate);
    expect(preview[0]?.status).toBe("excluded");
  });

  test("excludes pre-origin dates", () => {
    const preview = previewBalanceHistoryImport(
      [{ balanceMinor: 100_000_00, date: "2026-01-01" }],
      PLAN_CTX,
    );
    expect(preview[0]?.status).toBe("excluded");
    expect(preview[0]?.reason).toBe(BALANCE_HISTORY_MESSAGES.preOrigin);
  });

  test("skips idempotent rows that already exist with the same balance", () => {
    const ctx: BalanceHistoryDebtContext = {
      ...PLAN_CTX,
      balanceRebaselines: [
        {
          annualInterestRate: "0.03",
          baselineDate: "2026-06-15",
          endDate: "2046-01-15",
          nextPaymentDate: "2026-07-15",
          outstandingBalanceMinor: 140_000_00,
          startsAtBaseline: false,
        },
      ],
    };
    const preview = previewBalanceHistoryImport(
      [{ balanceMinor: 140_000_00, date: "2026-06-15" }],
      ctx,
    );
    expect(preview[0]?.status).toBe("skipped");
    expect(preview[0]?.driftMinor).toBe(0);
  });

  test("excludes duplicate dates with a different balance", () => {
    const ctx: BalanceHistoryDebtContext = {
      ...PLAN_CTX,
      balanceRebaselines: [
        {
          annualInterestRate: "0.03",
          baselineDate: "2026-06-15",
          endDate: "2046-01-15",
          nextPaymentDate: "2026-07-15",
          outstandingBalanceMinor: 140_000_00,
          startsAtBaseline: false,
        },
      ],
    };
    const preview = previewBalanceHistoryImport(
      [{ balanceMinor: 138_000_00, date: "2026-06-15" }],
      ctx,
    );
    expect(preview[0]?.status).toBe("excluded");
    expect(preview[0]?.reason).toBe(BALANCE_HISTORY_MESSAGES.duplicateDate);
  });

  test("excludes duplicate dates within the batch", () => {
    const preview = previewBalanceHistoryImport(
      [
        { balanceMinor: 140_000_00, date: "2026-06-15" },
        { balanceMinor: 139_000_00, date: "2026-06-15" },
      ],
      PLAN_CTX,
    );
    expect(preview.find((row) => row.status === "accepted")).toBeDefined();
    expect(
      preview.find((row) => row.reason === BALANCE_HISTORY_MESSAGES.duplicateInBatch)
        ?.status,
    ).toBe("excluded");
  });

  test("chains composition: the second row composes off the first accepted row", () => {
    const plan = planBalanceHistoryImport(
      [
        { balanceMinor: 145_000_00, date: "2026-04-15" },
        { balanceMinor: 140_000_00, date: "2026-06-15" },
      ],
      PLAN_CTX,
    );
    expect(plan.previews.filter((row) => row.status === "accepted")).toHaveLength(2);
    expect(plan.composed).toHaveLength(2);
    expect(plan.composed[0]?.baselineDate).toBe("2026-04-15");
    expect(plan.composed[1]?.baselineDate).toBe("2026-06-15");
    expect(plan.composed[1]?.endDate).toBe(plan.composed[0]?.endDate);
  });

  test("drift is computed vs the vigente curve, not prior batch rows", () => {
    const single = previewBalanceHistoryImport(
      [{ balanceMinor: 140_000_00, date: "2026-06-15" }],
      PLAN_CTX,
    )[0]!;
    const batch = planBalanceHistoryImport(
      [
        { balanceMinor: 145_000_00, date: "2026-04-15" },
        { balanceMinor: 140_000_00, date: "2026-06-15" },
      ],
      PLAN_CTX,
    );
    const secondInBatch = batch.previews.find((row) => row.date === "2026-06-15")!;
    expect(secondInBatch.driftMinor).toBe(single.driftMinor);
  });
});

describe("composeBalanceHistoryRebaselines", () => {
  test("returns only accepted rows in date order", () => {
    const preview = previewBalanceHistoryImport(
      [
        { balanceMinor: 0, date: "2026-05-15" },
        { balanceMinor: 145_000_00, date: "2026-04-15" },
      ],
      PLAN_CTX,
    );
    const composed = composeBalanceHistoryRebaselines(preview, PLAN_CTX);
    expect(composed).toHaveLength(1);
    expect(composed[0]?.baselineDate).toBe("2026-04-15");
  });

  test("honours an optional annual rate override per row", () => {
    const preview = previewBalanceHistoryImport(
      [{ annualRate: "0.025", balanceMinor: 140_000_00, date: "2026-06-15" }],
      PLAN_CTX,
    );
    const composed = composeBalanceHistoryRebaselines(preview, PLAN_CTX);
    expect(composed[0]?.annualInterestRate).toBe("0.025");
  });
});

describe("parseBalanceHistoryRows", () => {
  test("rejects non-integer balanceMinor values", () => {
    const result = parseBalanceHistoryRows([
      { balanceMinor: "140000", date: "2026-06-15" },
    ]);
    expect(result).toEqual({
      error: BALANCE_HISTORY_MESSAGES.invalidSeries,
      ok: false,
    });
  });

  test("accepts a well-formed series", () => {
    const result = parseBalanceHistoryRows([
      { annualRate: "0.03", balanceMinor: 140_000_00, date: "2026-06-15" },
    ]);
    expect(result).toEqual({
      ok: true,
      rows: [{ annualRate: "0.03", balanceMinor: 140_000_00, date: "2026-06-15" }],
    });
  });
});
