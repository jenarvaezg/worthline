import { describe, expect, it } from "vitest";

import {
  annualRateFromMonthlyPayment,
  monthlyPaymentFromAnnualRate,
  remainingMonthlyPayments,
} from "./amortization";

describe("current-state debt amortization helpers", () => {
  it("rounds the remaining term up to full monthly payments", () => {
    expect(remainingMonthlyPayments("2026-07-02", "2032-06-30")).toBe(72);
    expect(remainingMonthlyPayments("2026-07-02", "2026-07-02")).toBe(0);
  });

  it("round-trips a French payment and annual rate", () => {
    const payment = monthlyPaymentFromAnnualRate(118_000, 2.35, 72);

    expect(payment).toBeCloseTo(1758.75, 2);

    const solved = annualRateFromMonthlyPayment(118_000, payment ?? 0, 72);

    expect(solved.kind).toBe("ok");
    expect(solved.kind === "ok" ? solved.annualRatePercent : null).toBeCloseTo(2.35, 6);
  });

  it("rejects a payment that cannot amortize by the end date", () => {
    const solved = annualRateFromMonthlyPayment(118_000, 1_000, 72);

    expect(solved).toEqual({
      kind: "payment-too-low",
      minimumPayment: 118_000 / 72,
    });
  });
});
