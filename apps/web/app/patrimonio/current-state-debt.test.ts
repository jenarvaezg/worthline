import { describe, expect, test } from "vitest";

import {
  deriveCurrentStateDebt,
  type CurrentStateDebtRawInput,
} from "./current-state-debt";

/**
 * Unit tests for the pure current-state-debt derivation (ADR 0056, #677):
 * rate → cuota, cuota → tipo (round-trip), the infeasible-payment state, and
 * date/input guards. Mirrors the honesty check the client island renders live.
 */

const BASE: CurrentStateDebtRawInput = {
  annualRatePercent: "2,35",
  baselineDate: "2026-07-02",
  endDate: "2032-06-30",
  inputMode: "rate",
  monthlyPayment: "",
  nextPaymentDate: "2026-08-01",
  outstandingBalance: "118.000,00",
};

describe("deriveCurrentStateDebt — rate → cuota", () => {
  test("derives a positive monthly payment from a declared annual rate", () => {
    const result = deriveCurrentStateDebt(BASE);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.annualInterestRate).toBe("0.0235");
    expect(result.monthlyPaymentMinor).toBeGreaterThan(0);
    expect(result.outstandingBalanceMinor).toBe(118_000_00);
    expect(result.months).toBeGreaterThan(0);
  });

  test("a 0% rate derives the flat balance/months payment", () => {
    const result = deriveCurrentStateDebt({
      ...BASE,
      annualRatePercent: "0",
      endDate: "2027-08-01",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.annualInterestRate).toBe("0");
    expect(result.monthlyPaymentMinor).toBe(Math.round(118_000_00 / result.months));
  });
});

describe("deriveCurrentStateDebt — cuota → tipo (round-trip)", () => {
  test("solves the equivalent annual rate from a declared cuota", () => {
    const fromRate = deriveCurrentStateDebt(BASE);
    expect(fromRate.ok).toBe(true);
    if (!fromRate.ok) return;

    const fromPayment = deriveCurrentStateDebt({
      ...BASE,
      inputMode: "payment",
      monthlyPayment: String(fromRate.monthlyPaymentMinor / 100).replace(".", ","),
    });
    expect(fromPayment.ok).toBe(true);
    if (!fromPayment.ok) return;

    // Round-trips back to (very close to) the original declared rate.
    expect(Number(fromPayment.annualInterestRate)).toBeCloseTo(
      Number(fromRate.annualInterestRate),
      3,
    );
  });
});

describe("deriveCurrentStateDebt — infeasible payment", () => {
  test("a cuota below the zero-rate minimum is rejected with a Spanish hint", () => {
    const result = deriveCurrentStateDebt({
      ...BASE,
      inputMode: "payment",
      monthlyPayment: "10,00",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("Mínimo");
    expect(result.error).toContain("€/mes");
  });
});

describe("deriveCurrentStateDebt — guards", () => {
  test("rejects a non-positive outstanding balance", () => {
    const result = deriveCurrentStateDebt({ ...BASE, outstandingBalance: "0" });
    expect(result).toEqual({
      error: "Introduce un saldo pendiente mayor que 0 €.",
      ok: false,
    });
  });

  test("rejects a malformed end date", () => {
    const result = deriveCurrentStateDebt({ ...BASE, endDate: "30/06/2032" });
    expect(result).toEqual({ error: "La fecha de fin no es válida.", ok: false });
  });

  test("rejects a next-payment date before the baseline", () => {
    const result = deriveCurrentStateDebt({ ...BASE, nextPaymentDate: "2026-07-01" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("no puede ser anterior a hoy");
  });

  test("rejects an end date before the next payment", () => {
    const result = deriveCurrentStateDebt({ ...BASE, endDate: "2026-07-15" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("no puede ser anterior a la próxima cuota");
  });

  test("rejects a negative annual rate", () => {
    const result = deriveCurrentStateDebt({ ...BASE, annualRatePercent: "-1" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("tipo anual");
  });

  test("rejects a non-positive declared cuota", () => {
    const result = deriveCurrentStateDebt({
      ...BASE,
      inputMode: "payment",
      monthlyPayment: "0",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("cuota mensual mayor que 0");
  });
});
