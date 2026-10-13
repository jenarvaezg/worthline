import type { DebtModel, ValuationCadence } from "@worthline/domain";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";

vi.mock("@web/pending-submit", () => ({
  PendingSubmit: ({ children }: { children: ReactNode }) => (
    <button type="submit">{children}</button>
  ),
}));

import { DebtModelForm } from "./debt-model-form";

/** «Modelo de deuda», the debt ficha's panel (#1848, from `DebtModelSection`). */
function renderFor(
  debtModel: DebtModel | null,
  valuationCadence: ValuationCadence | null,
  formError: { formId: string; message: string } | null = null,
) {
  return renderToStaticMarkup(
    <DebtModelForm
      currentUrl="/patrimonio/wl_hld_l_mortgage/editar"
      debtModel={debtModel}
      formError={formError ? { ...formError, values: {} } : null}
      liabilityId="l_mortgage"
      valuationCadence={valuationCadence}
    />,
  );
}

describe("DebtModelForm — the model selector", () => {
  test("offers every model, with none as the empty choice", () => {
    const markup = renderFor(null, null);
    expect(markup).toContain('name="debtModel"');
    expect(markup).toContain("Sin modelo");
    expect(markup).toContain("Amortizable (préstamo francés)");
    expect(markup).toContain("Guardar modelo");
  });

  test("prints its own refusal inside the panel", () => {
    expect(
      renderFor(null, null, { formId: "debtModel", message: "Modelo no válido." }),
    ).toContain("Modelo no válido.");
  });
});

describe("DebtModelForm — valuation cadence advanced control (ADR 0031, #393)", () => {
  test("shows the cadence control for an amortizable debt", () => {
    const markup = renderFor("amortizable", null);
    expect(markup).toContain("Cadencia de valoración");
    expect(markup).toContain("Escalonado (por defecto)");
    expect(markup).toContain("Interpolado (suave a diario)");
  });

  test("shows the cadence control for a revolving debt", () => {
    expect(renderFor("revolving", null)).toContain("Cadencia de valoración");
  });

  test("does NOT show the cadence control for an informal debt", () => {
    expect(renderFor("informal", null)).not.toContain("Cadencia de valoración");
  });

  test("does NOT show the cadence control when no model is set", () => {
    expect(renderFor(null, null)).not.toContain("Cadencia de valoración");
  });

  test("reflects the stored cadence as the selected option (interpolated)", () => {
    expect(renderFor("amortizable", "interpolated")).toMatch(
      /value="interpolated"[^>]*selected/,
    );
  });

  test("defaults to step when the stored cadence is null", () => {
    expect(renderFor("amortizable", null)).toMatch(/value="step"[^>]*selected/);
  });

  test("a refused cadence unfolds its disclosure and says why there", () => {
    const markup = renderFor("amortizable", null, {
      formId: "cadence",
      message: "Cadencia no válida.",
    });
    expect(markup).toContain('<details class="anchorEdit" open=""');
    expect(markup).toContain("Cadencia no válida.");
  });
});
