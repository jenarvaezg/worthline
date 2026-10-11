/**
 * Unit tests for the pure payout-entry form module (PRD #652 S1, #656, ADR 0054):
 * a one-off payout field map → write, and the per-occurrence exclusion toggle. No
 * React, no DB. The recurring declaration's parser is tested beside the income
 * door (`_income/income-recurrence.test.ts`, #1673).
 */

import { describe, expect, test } from "vitest";

import { buildPayoutResult, type PayoutFields, toggleExclusion } from "./cobros-form";

function payoutFields(over: Partial<PayoutFields> = {}): PayoutFields {
  return { dateISO: "2026-05-10", amount: "275,00", note: "", ...over };
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
