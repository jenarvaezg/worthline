import type { AccruedInterestAtDate } from "@worthline/domain";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";

vi.mock("@web/pending-submit", () => ({
  PendingSubmit: ({ children }: { children: ReactNode }) => (
    <button type="submit">{children}</button>
  ),
}));

import { DebtRecalibrateForm } from "./debt-recalibrate-form";

/**
 * «Recalibrar con saldo real» (ADR 0056, PRD #670 S3, #678), the debt ficha's panel
 * since #1848. Whether it is offered at all — only with a curve — is
 * `debt-ficha-shape`'s; this pins what it says once it is.
 */
function render(
  currentModelledBalanceMinor: number,
  currentDebtAccrual: AccruedInterestAtDate | null = null,
) {
  return renderToStaticMarkup(
    <DebtRecalibrateForm
      currentDebtAccrual={currentDebtAccrual}
      currentModelledBalanceMinor={currentModelledBalanceMinor}
      currentUrl="/patrimonio/wl_hld_l_mortgage/editar"
      formError={null}
      liabilityId="l_mortgage"
      privacyMode={false}
      today="2026-06-14"
    />,
  );
}

describe("DebtRecalibrateForm — the modelled balance beside the repair (#678)", () => {
  test("shows the current modelled balance and the form that recalibrates it", () => {
    const markup = render(195_000_00);
    expect(markup).toContain("Saldo modelado a día de hoy");
    expect(markup).toContain("195.000");
    expect(markup).toContain("Saldo real (EUR)");
    expect(markup).toContain("Fecha de recalibración");
    expect(markup).toContain("Recalibrar saldo");
  });
});

describe("DebtRecalibrateForm — principal vs the bank's settlement amount (#1292)", () => {
  const ACCRUAL: AccruedInterestAtDate = {
    accruedInterestMinor: 17_08,
    annualInterestRate: "0.0589",
    cycleDays: 31,
    cycleEndDate: "2026-08-08",
    cycleStartDate: "2026-07-08",
    elapsedDays: 19,
    principalMinor: 5_494_98,
    settlementEstimateMinor: 5_512_06,
  };

  test("names both magnitudes at the moment of repair, and which one this form takes", () => {
    const markup = render(5_494_98, ACCRUAL);

    // The app's figure is labelled, not left implicit.
    expect(markup).toContain("capital pendiente");
    // …and the bank's, with the accrual that separates them and the date it runs from.
    expect(markup).toContain("importe de liquidación");
    expect(markup).toContain("2026-07-08");
    expect(markup).toContain("5512");
    // The instruction that keeps accrued interest out of the persisted capital.
    expect(markup).toContain("se quedan dentro del capital");
  });

  test("says nothing about settlement when no interest has accrued yet", () => {
    // On a cuota date the interest has just been paid: there is no second
    // magnitude to warn about, so the block stays out of the way.
    const markup = render(5_494_98, {
      ...ACCRUAL,
      accruedInterestMinor: 0,
      elapsedDays: 0,
      settlementEstimateMinor: 5_494_98,
    });
    expect(markup).not.toContain("importe de liquidación");
  });

  test("says nothing when the debt has no running cycle at all", () => {
    expect(render(5_494_98, null)).not.toContain("importe de liquidación");
  });
});
