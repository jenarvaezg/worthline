import type { EffectiveAmortizationPlan } from "@worthline/domain";
import { describe, expect, test } from "vitest";

import {
  deriveRecalibrationRebaseline,
  validateRecalibrateDebt,
} from "./recalibrate-debt";

/**
 * Unit tests for the pure "recalibrar con saldo real" derivation (ADR 0056,
 * PRD #670 S3, #678): the two-field validation (saldo real + fecha, no future),
 * and composing the persisted rate/end-date/next-cuota from whichever plan or
 * prior re-baseline governs the declared date — the smaller sibling of
 * `deriveCurrentStateDebt` (S1/S2), since rate and term are NOT re-entered here.
 */

describe("validateRecalibrateDebt", () => {
  const TODAY = "2026-07-02";

  test("accepts a positive balance and a non-future ISO date", () => {
    const result = validateRecalibrateDebt({
      balanceDate: "2026-06-15",
      outstandingBalance: "118.000,00",
      today: TODAY,
    });
    expect(result).toEqual({
      balanceDate: "2026-06-15",
      ok: true,
      outstandingBalanceMinor: 118_000_00,
    });
  });

  test("accepts today itself", () => {
    const result = validateRecalibrateDebt({
      balanceDate: TODAY,
      outstandingBalance: "1.000",
      today: TODAY,
    });
    expect(result.ok).toBe(true);
  });

  test("rejects a zero or negative balance", () => {
    const result = validateRecalibrateDebt({
      balanceDate: TODAY,
      outstandingBalance: "0",
      today: TODAY,
    });
    expect(result).toEqual({
      error: "Introduce un saldo real mayor que 0 €.",
      ok: false,
    });
  });

  test("rejects a malformed date", () => {
    const result = validateRecalibrateDebt({
      balanceDate: "not-a-date",
      outstandingBalance: "1.000",
      today: TODAY,
    });
    expect(result).toEqual({ error: "La fecha del saldo no es válida.", ok: false });
  });

  test("rejects a future date", () => {
    const result = validateRecalibrateDebt({
      balanceDate: "2026-07-03",
      outstandingBalance: "1.000",
      today: TODAY,
    });
    expect(result).toEqual({
      error: "La fecha del saldo no puede ser futura.",
      ok: false,
    });
  });
});

describe("deriveRecalibrationRebaseline", () => {
  const EFFECTIVE: EffectiveAmortizationPlan = {
    effectiveFrom: "2020-01-01",
    plan: {
      annualInterestRate: "0.03",
      disbursementDate: "2020-01-01",
      firstPaymentDate: "2020-02-15",
      initialCapitalMinor: 200_000_00,
      termMonths: 240,
    },
  };

  test("carries the plan's own rate forward when there are no revisions", () => {
    const result = deriveRecalibrationRebaseline({
      balanceDate: "2026-06-15",
      effective: EFFECTIVE,
      revisions: [],
    });
    expect(result).toEqual({
      annualInterestRate: "0.03",
      endDate: "2040-01-15",
      nextPaymentDate: "2026-07-15",
      ok: true,
    });
  });

  test("folds in the latest rate revision on/before the balance date", () => {
    const result = deriveRecalibrationRebaseline({
      balanceDate: "2026-06-15",
      effective: EFFECTIVE,
      revisions: [
        { newAnnualInterestRate: "0.04", revisionDate: "2023-01-15" },
        { newAnnualInterestRate: "0.045", revisionDate: "2026-01-15" },
        // Dated AFTER the balance date — must NOT apply.
        { newAnnualInterestRate: "0.09", revisionDate: "2026-12-15" },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.annualInterestRate).toBe("0.045");
  });

  test("ignores a revision dated before the effective plan/re-baseline starts", () => {
    const result = deriveRecalibrationRebaseline({
      balanceDate: "2026-06-15",
      effective: EFFECTIVE,
      revisions: [{ newAnnualInterestRate: "0.09", revisionDate: "2019-01-01" }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.annualInterestRate).toBe("0.03");
  });

  test("picks the next cuota on the plan's own day-of-month cadence, strictly after the balance date", () => {
    const result = deriveRecalibrationRebaseline({
      balanceDate: "2026-06-10",
      effective: EFFECTIVE,
      revisions: [],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Cadence day is 15 (firstPaymentDate); the balance date (10th) is before it,
    // so the SAME month's 15th is the next cuota — not the following month's.
    expect(result.nextPaymentDate).toBe("2026-06-15");
  });

  test("never returns a next-cuota date equal to the balance date itself", () => {
    // Regression guard: `amortizableBalanceAtDate` reads a query landing exactly
    // ON the schedule's first-payment date as "the cuota already happened", so a
    // balance date that itself falls on the cadence day must roll to the
    // FOLLOWING cuota — otherwise the re-baseline's own declared balance would
    // read back short by that cuota's principal.
    const result = deriveRecalibrationRebaseline({
      balanceDate: "2026-06-15", // exactly on the 15th-of-month cadence
      effective: EFFECTIVE,
      revisions: [],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.nextPaymentDate).toBe("2026-07-15");
  });

  test("errors when the balance date is before the debt's own current-state baseline", () => {
    const result = deriveRecalibrationRebaseline({
      balanceDate: "2026-01-01",
      effective: { startsAfterTarget: true },
      revisions: [],
    });
    expect(result).toEqual({
      error: "La fecha del saldo no puede ser anterior al inicio de esta deuda.",
      ok: false,
    });
  });

  test("errors when the debt has no plan or re-baseline to recalibrate", () => {
    const result = deriveRecalibrationRebaseline({
      balanceDate: "2026-01-01",
      effective: null,
      revisions: [],
    });
    expect(result).toEqual({
      error: "Esta deuda no tiene un plan de amortización que recalibrar.",
      ok: false,
    });
  });
});
