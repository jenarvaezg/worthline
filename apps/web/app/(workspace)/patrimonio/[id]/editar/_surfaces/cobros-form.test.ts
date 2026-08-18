/**
 * Unit tests for the pure payout-entry form module (PRD #652 S1, #656, ADR 0054).
 *
 * All parsing + validation for the "Cobros" hand-entry surface lives here
 * (interaction-patterns §7): a one-off payout field map → write, a schedule field
 * map → write, and the per-occurrence exclusion toggle. No React, no DB. A payout
 * is attribution, never a figure — this module only shapes what `store.payouts`
 * persists.
 */

import { describe, expect, test } from "vitest";

import {
  buildPayoutResult,
  buildPayoutScheduleResult,
  type PayoutFields,
  type PayoutScheduleFields,
  parseScheduleExpenses,
  toggleExclusion,
} from "./cobros-form";

function payoutFields(over: Partial<PayoutFields> = {}): PayoutFields {
  return { dateISO: "2026-05-10", amount: "275,00", note: "", ...over };
}

function scheduleFields(over: Partial<PayoutScheduleFields> = {}): PayoutScheduleFields {
  return {
    label: "Alquiler piso",
    amount: "1000",
    cadence: "monthly",
    startISO: "2024-01-01",
    endISO: "",
    expenses: "",
    ...over,
  };
}

describe("buildPayoutResult (one-off)", () => {
  test("parses an es-ES amount into minor units, keeps the note", () => {
    const result = buildPayoutResult(payoutFields({ note: "Dividendo variable" }));
    expect(result).toEqual({
      ok: true,
      payout: { dateISO: "2026-05-10", amountMinor: 27500, note: "Dividendo variable" },
    });
  });

  test("omits the note entirely when blank (never note: undefined)", () => {
    const result = buildPayoutResult(payoutFields({ note: "   " }));
    expect(result.ok).toBe(true);
    if (result.ok) expect("note" in result.payout).toBe(false);
  });

  test("rejects a non-positive amount", () => {
    expect(buildPayoutResult(payoutFields({ amount: "0" })).ok).toBe(false);
    expect(buildPayoutResult(payoutFields({ amount: "" })).ok).toBe(false);
    const neg = buildPayoutResult(payoutFields({ amount: "-5" }));
    expect(neg.ok).toBe(false);
    if (!neg.ok) expect(neg.error).toMatch(/mayor que cero/);
  });

  test("rejects an invalid or overflowing date", () => {
    expect(buildPayoutResult(payoutFields({ dateISO: "" })).ok).toBe(false);
    expect(buildPayoutResult(payoutFields({ dateISO: "10/05/2026" })).ok).toBe(false);
    expect(buildPayoutResult(payoutFields({ dateISO: "2026-02-30" })).ok).toBe(false);
  });
});

describe("buildPayoutScheduleResult", () => {
  test("parses a full schedule with an end date", () => {
    const result = buildPayoutScheduleResult(
      scheduleFields({ amount: "1000", endISO: "2026-02-01" }),
    );
    expect(result).toEqual({
      ok: true,
      schedule: {
        label: "Alquiler piso",
        amountMinor: 100000,
        cadence: "monthly",
        startISO: "2024-01-01",
        endISO: "2026-02-01",
      },
    });
  });

  test("omits endISO when blank (never endISO: undefined)", () => {
    const result = buildPayoutScheduleResult(scheduleFields({ endISO: "" }));
    expect(result.ok).toBe(true);
    if (result.ok) expect("endISO" in result.schedule).toBe(false);
  });

  test("rejects a blank label", () => {
    const result = buildPayoutScheduleResult(scheduleFields({ label: "  " }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/concepto/i);
  });

  test("rejects a non-positive amount", () => {
    expect(buildPayoutScheduleResult(scheduleFields({ amount: "0" })).ok).toBe(false);
  });

  test("rejects an unknown cadence", () => {
    const result = buildPayoutScheduleResult(scheduleFields({ cadence: "daily" }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/cadencia/i);
  });

  test("accepts every valid cadence", () => {
    for (const cadence of ["weekly", "monthly", "quarterly", "annual"]) {
      expect(buildPayoutScheduleResult(scheduleFields({ cadence })).ok).toBe(true);
    }
  });

  test("rejects an invalid start date", () => {
    expect(buildPayoutScheduleResult(scheduleFields({ startISO: "nope" })).ok).toBe(
      false,
    );
  });

  test("rejects an end date before the start", () => {
    const result = buildPayoutScheduleResult(
      scheduleFields({ startISO: "2025-01-01", endISO: "2024-01-01" }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/fin/i);
  });
});

describe("toggleExclusion", () => {
  test("adds a date that is not yet excluded", () => {
    expect(toggleExclusion([], "2025-06-01")).toEqual(["2025-06-01"]);
  });

  test("removes a date already excluded", () => {
    expect(toggleExclusion(["2025-06-01", "2025-09-01"], "2025-06-01")).toEqual([
      "2025-09-01",
    ]);
  });
});

// ── declared expenses (#1448) ─────────────────────────────────────────────────

describe("parseScheduleExpenses", () => {
  test("an empty field is 'not declared', never a zero", () => {
    // The distinction is the whole guard: with no declaration a rented property
    // keeps the housing tier's 3 %, instead of sealing its gross yield as if net.
    expect(parseScheduleExpenses("")).toEqual({ ok: true, expensesMinor: null });
    expect(parseScheduleExpenses("   ")).toEqual({ ok: true, expensesMinor: null });
  });

  test("a declared 0 is a statement and parses as one", () => {
    expect(parseScheduleExpenses("0")).toEqual({ ok: true, expensesMinor: 0 });
  });

  test("parses an es-ES amount into minor units", () => {
    expect(parseScheduleExpenses("1.234,56")).toEqual({
      ok: true,
      expensesMinor: 123_456,
    });
  });

  test("rejects garbage instead of coercing it to zero", () => {
    const result = parseScheduleExpenses("doscientos");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/gastos válidos/);
  });

  test("rejects a negative cost", () => {
    const result = parseScheduleExpenses("-50");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/negativos/);
  });
});

describe("buildPayoutScheduleResult + expenses", () => {
  test("carries the declared expenses through", () => {
    const result = buildPayoutScheduleResult(scheduleFields({ expenses: "250" }));
    expect(result.ok && result.schedule.expensesMinor).toBe(25_000);
  });

  test("omits the field entirely when blank (never expensesMinor: undefined)", () => {
    const result = buildPayoutScheduleResult(scheduleFields());
    expect(result.ok).toBe(true);
    if (result.ok) expect("expensesMinor" in result.schedule).toBe(false);
  });

  test("costs above the income are accepted: a flat can cost more than it earns", () => {
    const result = buildPayoutScheduleResult(
      scheduleFields({ amount: "1000", expenses: "1200" }),
    );
    expect(result.ok && result.schedule.expensesMinor).toBe(120_000);
  });

  test("an unparseable cost fails the whole write", () => {
    expect(buildPayoutScheduleResult(scheduleFields({ expenses: "??" })).ok).toBe(false);
  });
});
