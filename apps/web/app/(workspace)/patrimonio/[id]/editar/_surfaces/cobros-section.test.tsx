/**
 * Wiring test for the Cobros surface (PRD #652 S1, #656). Renders the server
 * section (with its client grid island) to static markup and asserts it surfaces
 * the derived + one-off figures, both entry forms, the schedule-management
 * controls, the renta-pasiva strip (coverage only when spending is known), and the
 * honest attribution note. Prior art: housing-valuation-section.test.tsx.
 */

import {
  formatMoneyMinorPrivacy,
  type Payout,
  type PayoutSchedule,
} from "@worthline/domain";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";

import { CobrosSection } from "./cobros-section";

const TODAY = "2026-07-06";

const RENT: PayoutSchedule = {
  id: "sch-rent",
  holdingId: "h1",
  label: "Alquiler piso",
  amountMinor: 100000,
  cadence: "monthly",
  startISO: "2026-01-01",
  endISO: null,
  exclusions: [],
};

const DIVIDEND: Payout = {
  id: "o1",
  holdingId: "h1",
  dateISO: "2026-05-20",
  amountMinor: 34000,
  note: "Dividendo extraordinario",
};

const noop = async () => {};

function renderSection(over: { monthlySpendingMinor?: number | null } = {}) {
  return renderToStaticMarkup(
    <CobrosSection
      createPayoutAction={noop}
      createPayoutScheduleAction={noop}
      currency="EUR"
      currentUrl="/patrimonio/h1/editar"
      deletePayoutAction={noop}
      deletePayoutScheduleAction={noop}
      monthlySpendingMinor={over.monthlySpendingMinor ?? null}
      payouts={[DIVIDEND]}
      privacyMode={false}
      schedules={[RENT]}
      today={TODAY}
      updatePayoutScheduleAction={noop}
    />,
  );
}

describe("CobrosSection wiring", () => {
  test("renders the section heading and the honest attribution note", () => {
    const markup = renderSection();
    expect(markup).toContain("Cobros");
    expect(markup).toContain("atribución, no contabilidad");
  });

  test("surfaces the trailing passive-income figure (rent + dividend across the year)", () => {
    const markup = renderSection();
    // May 2026 in the current-year grid carries rent + the one-off dividend.
    const mayTotal = formatMoneyMinorPrivacy(
      { amountMinor: 134000, currency: "EUR" },
      false,
    );
    expect(markup).toContain(mayTotal);
    expect(markup).toContain("Renta pasiva");
  });

  test("shows both entry forms and the cadence options", () => {
    const markup = renderSection();
    expect(markup).toContain("Añadir cobro");
    expect(markup).toContain("Añadir recurrente");
    expect(markup).toContain('name="dateISO"');
    expect(markup).toContain('name="cadence"');
    expect(markup).toContain("Trimestral");
  });

  test("lists the declared schedule with end + delete controls", () => {
    const markup = renderSection();
    expect(markup).toContain("Alquiler piso");
    expect(markup).toContain("Terminar hoy");
    expect(markup).toContain("Eliminar");
  });

  test("omits the coverage percentage when no spending is declared", () => {
    expect(renderSection({ monthlySpendingMinor: null })).not.toContain(
      "de tu gasto declarado",
    );
  });

  test("shows the coverage percentage when spending is declared", () => {
    const markup = renderSection({ monthlySpendingMinor: 220000 });
    expect(markup).toContain("de tu gasto declarado");
  });
});
