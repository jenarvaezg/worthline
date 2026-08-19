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

function renderSection(
  over: { monthlySpendingMinor?: number | null; schedules?: PayoutSchedule[] } = {},
) {
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
      schedules={over.schedules ?? [RENT]}
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

// ── declared expenses (#1448) ─────────────────────────────────────────────────

describe("CobrosSection — declared expenses", () => {
  test("the recurring form offers a costs field and says what it is for", () => {
    const markup = renderSection();

    expect(markup).toContain("Gastos del cobro recurrente");
    expect(markup).toContain('name="expenses"');
    // The user has to learn WHY it matters, or the field reads as budgeting.
    expect(markup).toContain("alquiler neto");
  });

  test("a rent with no declared costs says so on its row", () => {
    // The absence is what keeps the property on the 3 % default, so it cannot be
    // an invisible blank: the row has to explain the rate that did not move.
    expect(renderSection()).toContain("sin gastos declarados");
  });

  test("a rent with declared costs names them, and the row can be corrected", () => {
    const markup = renderSection({
      schedules: [{ ...RENT, expensesMinor: 25_000 }],
    });

    expect(markup).toContain(
      `${formatMoneyMinorPrivacy({ amountMinor: 25_000, currency: "EUR" }, false)} de gastos`,
    );
    // Prefilled through the shared money-input formatter (es-ES, two decimals), so
    // an existing declaration is edited rather than re-typed.
    expect(markup).toContain('value="250,00"');
    expect(markup).toContain('name="saveExpenses"');
  });
});

// ── the net lens (#1463) ──────────────────────────────────────────────────────

describe("CobrosSection — net passive income (#1463)", () => {
  test("nets the headline and names gross − expenses when the schedule declares costs", () => {
    const markup = renderSection({
      monthlySpendingMinor: 220000,
      schedules: [{ ...RENT, expensesMinor: 20000 }],
    });

    // 7 rents (Jan–Jul 2026) × 100.000 + the 34.000 dividend = 734.000 gross;
    // 7 × 20.000 declared expenses = 140.000; net 594.000.
    expect(markup).toContain("Renta pasiva neta · últimos 12 meses");
    expect(markup).toContain(
      formatMoneyMinorPrivacy({ amountMinor: 594000, currency: "EUR" }, false),
    );
    expect(markup).toContain("brutos");
    expect(markup).toContain(
      formatMoneyMinorPrivacy({ amountMinor: 734000, currency: "EUR" }, false),
    );
    expect(markup).toContain("gastos declarados");
    expect(markup).toContain(
      formatMoneyMinorPrivacy({ amountMinor: 140000, currency: "EUR" }, false),
    );
    // Coverage runs on net: 594.000 / 2.640.000 = 22.5 % — never the gross 27.8 %.
    expect(markup).toContain("22.5");
    expect(markup).not.toContain("27.8");
  });

  test("without declared costs the strip reads exactly as before (gross, no sub-line)", () => {
    const markup = renderSection({ monthlySpendingMinor: 220000 });
    expect(markup).toContain("Renta pasiva · últimos 12 meses");
    expect(markup).not.toContain("Renta pasiva neta");
    expect(markup).not.toContain("brutos");
  });

  test("a negative net (expenses above the rent) keeps the coverage bar at zero", () => {
    const markup = renderSection({
      monthlySpendingMinor: 220000,
      schedules: [{ ...RENT, expensesMinor: 150000 }],
    });

    // 7 × (100.000 − 150.000) − dividend still positive? gross 734.000,
    // expenses 1.050.000 → net −316.000: declarable, and the bar clamps at 0.
    expect(markup).toContain("Renta pasiva neta");
    expect(markup).toContain("width:0%");
  });
});
