import type { AmortizationPlanRecord } from "@worthline/db";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";

import { DebtPlanSection } from "./debt-plan-section";

/**
 * The «Plan» tab of an amortizable debt (#1848, from `DebtModelSection`).
 *
 * It shows the EXACT first cuota with its stub interest (ADR 0019, #190). The
 * opening period (disbursement → first payment) is longer than a month, so the
 * first cuota is larger than the regular cuota; the page must show it distinctly
 * from the regular cuota, computed from the day count.
 *
 * DISPLAY ONLY — this is presentation derived from the plan via the domain
 * `firstCuota` helper; it never touches a balance, snapshot, or net-worth figure.
 */
const BANK_PLAN: AmortizationPlanRecord = {
  annualInterestRate: "0.03",
  // The mid-month firma + later 1st-of-month first payment → a 46-day stub.
  disbursementDate: "2020-01-15",
  firstPaymentDate: "2020-03-01",
  id: "plan_1",
  initialCapitalMinor: 200_000_00,
  liabilityId: "l_mortgage",
  originalSigningDate: null,
  termMonths: 240,
};

function render(plan: AmortizationPlanRecord | null) {
  return renderToStaticMarkup(
    <DebtPlanSection
      currency="EUR"
      currentUrl="/patrimonio/wl_hld_l_mortgage/editar"
      formError={null}
      liabilityId="l_mortgage"
      plan={plan}
      privacyMode={false}
      today="2026-06-14"
    />,
  );
}

describe("DebtPlanSection — first cuota with stub interest (ADR 0019, #190)", () => {
  test("shows the exact first cuota (stub interest + first principal) for a >1-month stub", () => {
    const markup = render(BANK_PLAN);
    // First cuota = 766,67€ stub + 609,20€ principal = 1.375,86€, exact to the
    // cent. (Asserted on the cent-precise tail so the test is invariant to the
    // locale's thousands grouping across ICU builds.)
    expect(markup).toContain("375,86");
    expect(markup).toContain("Primera cuota");
    // The regular (subsequent) cuota is shown distinctly: 1.109,20€.
    expect(markup).toContain("109,20");
    expect(markup).toContain("Cuota habitual");
  });

  test("explains the stub interest and the day count it is computed from", () => {
    const markup = render(BANK_PLAN);
    // The stub interest itself is surfaced (766,67€) …
    expect(markup).toContain("766,67");
    // … as is the 46-day opening period it is derived from.
    expect(markup).toContain("46");
  });

  test("renders no cuota summary when there is no plan yet", () => {
    expect(render(null)).not.toContain("Primera cuota");
  });
});

describe("DebtPlanSection — «alta por estado actual» is the default create path (ADR 0056, #677)", () => {
  test("shows the current-state form (not the origin plan form) when no plan exists yet", () => {
    const markup = render(null);
    expect(markup).toContain("Saldo pendiente hoy");
    expect(markup).toContain("Guardar por estado actual");
    // The origin-declared form (ADR 0019) stays available, demoted to a details.
    expect(markup).toContain("¿Tienes los datos originales del préstamo?");
    expect(markup).toContain("Guardar plan");
    // Nothing to delete yet.
    expect(markup).not.toContain("Eliminar plan");
  });

  test("an existing plan keeps the origin editor as the only surface (update path unchanged)", () => {
    const markup = render(BANK_PLAN);
    expect(markup).not.toContain("Saldo pendiente hoy");
    expect(markup).not.toContain("Guardar por estado actual");
    expect(markup).toContain("Actualizar plan");
    expect(markup).toContain("Eliminar plan");
  });

  test("every form here returns to the tab it is on", () => {
    expect(render(BANK_PLAN)).toContain(
      'name="currentUrl" value="/patrimonio/wl_hld_l_mortgage/editar"',
    );
  });
});
