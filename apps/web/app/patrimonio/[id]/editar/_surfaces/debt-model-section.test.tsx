import type { AmortizationPlanRecord } from "@worthline/db";
import type { DebtModel, ValuationCadence } from "@worthline/domain";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";

import { DebtModelSection } from "./debt-model-section";

/**
 * The amortizable detail surface shows the EXACT first cuota with its stub
 * interest (ADR 0019, #190). The opening period (disbursement → first payment) is
 * longer than a month, so the first cuota is larger than the regular cuota; the
 * page must show it distinctly from the regular cuota, computed from the day count.
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
    <DebtModelSection
      amortizationPlan={plan}
      balanceAnchors={[]}
      debtModel="amortizable"
      earlyRepayments={[]}
      formError={null}
      liabilityId="l_mortgage"
      rateRevisions={[]}
      today="2026-06-14"
      valuationCadence={null}
    />,
  );
}

/** Render the surface for a given debt model + stored cadence. */
function renderFor(
  debtModel: DebtModel | null,
  valuationCadence: ValuationCadence | null,
) {
  return renderToStaticMarkup(
    <DebtModelSection
      amortizationPlan={null}
      balanceAnchors={[]}
      debtModel={debtModel}
      earlyRepayments={[]}
      formError={null}
      liabilityId="l_mortgage"
      rateRevisions={[]}
      today="2026-06-14"
      valuationCadence={valuationCadence}
    />,
  );
}

describe("DebtModelSection — first cuota with stub interest (ADR 0019, #190)", () => {
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
    const markup = render(null);
    expect(markup).not.toContain("Primera cuota");
  });
});

describe("DebtModelSection — valuation cadence advanced control (ADR 0031, #393)", () => {
  test("shows the cadence control for an amortizable debt", () => {
    const markup = renderFor("amortizable", null);
    expect(markup).toContain("Cadencia de valoración");
    expect(markup).toContain("Escalonado (por defecto)");
    expect(markup).toContain("Interpolado (suave a diario)");
  });

  test("shows the cadence control for a revolving debt", () => {
    const markup = renderFor("revolving", null);
    expect(markup).toContain("Cadencia de valoración");
  });

  test("does NOT show the cadence control for an informal debt", () => {
    const markup = renderFor("informal", null);
    expect(markup).not.toContain("Cadencia de valoración");
  });

  test("does NOT show the cadence control when no model is set", () => {
    const markup = renderFor(null, null);
    expect(markup).not.toContain("Cadencia de valoración");
  });

  test("reflects the stored cadence as the selected option (interpolated)", () => {
    const markup = renderFor("amortizable", "interpolated");
    // The interpolated option carries the selected attribute when stored.
    expect(markup).toMatch(/value="interpolated"[^>]*selected/);
  });

  test("defaults to step when the stored cadence is null", () => {
    const markup = renderFor("amortizable", null);
    expect(markup).toMatch(/value="step"[^>]*selected/);
  });
});

describe("DebtModelSection — «alta por estado actual» is the default create path (ADR 0056, #677)", () => {
  test("shows the current-state form (not the origin plan form) when no plan exists yet", () => {
    const markup = renderFor("amortizable", null);
    expect(markup).toContain("Saldo pendiente hoy");
    expect(markup).toContain("Guardar por estado actual");
    // The origin-declared form (ADR 0019) stays available, demoted to a details.
    expect(markup).toContain("¿Tienes los datos originales del préstamo?");
    expect(markup).toContain("Guardar plan");
  });

  test("an existing plan keeps the origin editor as the only surface (update path unchanged)", () => {
    const markup = render(BANK_PLAN);
    expect(markup).not.toContain("Saldo pendiente hoy");
    expect(markup).not.toContain("Guardar por estado actual");
    expect(markup).toContain("Actualizar plan");
  });
});
