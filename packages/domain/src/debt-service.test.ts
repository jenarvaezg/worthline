import { describe, expect, test } from "vitest";

import type { AmortizationPlanInput } from "./amortization";
import { monthlyDebtServiceAtDate } from "./debt-service";

/**
 * El mismo plan redondo que usa el testigo del interés devengado: 12.000 € al 12 %
 * a 12 meses, firmado el 2026-01-01 con primera cuota el 2026-02-01. La cuota
 * francesa sale 1.066,19 €.
 */
const ROUND: AmortizationPlanInput = {
  annualInterestRate: "0.12",
  disbursementDate: "2026-01-01",
  firstPaymentDate: "2026-02-01",
  initialCapitalMinor: 12_000_00,
  termMonths: 12,
};

describe("monthlyDebtServiceAtDate: la cuota vigente (#1520)", () => {
  test("es la del próximo pago, con su fecha y la del último", () => {
    const service = monthlyDebtServiceAtDate({ plan: ROUND, targetDate: "2026-04-15" });

    expect(service).not.toBeNull();
    expect(service!.paymentMinor).toBe(1_066_19);
    expect(service!.nextPaymentDate).toBe("2026-05-01");
    expect(service!.finalPaymentDate).toBe("2027-01-01");
  });

  test("en el tramo previo a la primera cuota ya pesa: la cuota está contratada", () => {
    const service = monthlyDebtServiceAtDate({ plan: ROUND, targetDate: "2026-01-10" });

    expect(service).not.toBeNull();
    expect(service!.nextPaymentDate).toBe("2026-02-01");
  });

  test("sobre la fecha de una cuota, la que pesa es la siguiente: esa ya se pagó", () => {
    const service = monthlyDebtServiceAtDate({ plan: ROUND, targetDate: "2026-05-01" });

    expect(service!.nextPaymentDate).toBe("2026-06-01");
  });

  test("un plan terminado no pesa nada: la deuda vencida no tiene cuota vigente", () => {
    expect(
      monthlyDebtServiceAtDate({ plan: ROUND, targetDate: "2027-01-01" }),
    ).toBeNull();
    expect(
      monthlyDebtServiceAtDate({ plan: ROUND, targetDate: "2030-06-01" }),
    ).toBeNull();
  });

  test("antes de que el dinero se desembolse no hay servicio de deuda", () => {
    expect(
      monthlyDebtServiceAtDate({ plan: ROUND, targetDate: "2025-12-31" }),
    ).toBeNull();
  });

  test("una revisión de tipo mueve la cuota vigente, no la contratada", () => {
    const revised = monthlyDebtServiceAtDate({
      plan: ROUND,
      revisions: [{ revisionDate: "2026-07-01", newAnnualInterestRate: "0.24" }],
      targetDate: "2026-09-15",
    });

    expect(revised).not.toBeNull();
    // Sin revisión la cuota de octubre sigue siendo la contratada; con ella, sube.
    expect(revised!.paymentMinor).toBeGreaterThan(1_066_19);
  });

  test("una amortización anticipada que reduce cuota baja la vigente", () => {
    const after = monthlyDebtServiceAtDate({
      earlyRepayments: [
        { repaymentDate: "2026-06-01", amountMinor: 3_000_00, mode: "reduce-payment" },
      ],
      plan: ROUND,
      targetDate: "2026-08-15",
    });

    expect(after).not.toBeNull();
    expect(after!.paymentMinor).toBeLessThan(1_066_19);
  });
});
