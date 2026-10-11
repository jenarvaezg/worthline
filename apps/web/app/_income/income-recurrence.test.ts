/**
 * Unit tests for the recurrence core of an income declaration (PRD #652 S1, #656,
 * ADR 0054; moved beside the income door by #1673). No React, no DB.
 */

import { describe, expect, test } from "vitest";

import {
  buildPayoutScheduleResult,
  type PayoutScheduleFields,
  parseScheduleExpenses,
} from "./income-recurrence";

function scheduleFields(over: Partial<PayoutScheduleFields> = {}): PayoutScheduleFields {
  return {
    label: "Alquiler piso",
    amount: "1000",
    cadence: "monthly",
    startISO: "2024-01-01",
    endISO: "",
    expenses: "",
    leaseRegime: "",
    rentRevision: "",
    rentRevisionReference: "",
    postMandatoryTermPolicy: "",
    ...over,
  };
}

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
        // The lease terms are always present and always explicit (#1521): a form
        // that never showed them declares three nulls, not three absences.
        leaseRegime: null,
        rentRevision: null,
        rentRevisionReference: null,
        postMandatoryTermPolicy: null,
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
