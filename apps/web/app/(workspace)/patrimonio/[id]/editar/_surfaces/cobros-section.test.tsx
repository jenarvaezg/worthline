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

import { type CobrosProps, CobrosRecord, CobrosSection } from "./cobros-section";

const TODAY = "2026-07-06";

const RENT: PayoutSchedule = {
  id: "sch-rent",
  nature: "passive",
  amountBasis: "real",
  assumedContributionThrough: null,
  provenance: null,
  provenanceAsOf: null,
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
  over: {
    doubleCount?: string | null;
    monthlySpendingMinor?: number | null;
    payouts?: Payout[];
    schedules?: PayoutSchedule[];
    showLeaseTerms?: boolean;
  } = {},
) {
  return renderToStaticMarkup(
    <CobrosSection
      acknowledgeWarningAction={noop}
      createPayoutAction={noop}
      createIncomeAction={noop}
      currency="EUR"
      currentUrl="/patrimonio/h1/editar"
      deletePayoutAction={noop}
      deletePayoutScheduleAction={noop}
      doubleCount={over.doubleCount ?? null}
      holdingId="h1"
      monthlySpendingMinor={over.monthlySpendingMinor ?? null}
      payouts={over.payouts ?? [DIVIDEND]}
      privacyMode={false}
      schedules={over.schedules ?? [RENT]}
      showLeaseTerms={over.showLeaseTerms ?? false}
      today={TODAY}
      updatePayoutScheduleAction={noop}
    />,
  );
}

describe("CobrosSection wiring", () => {
  test.each([
    [{ nature: null }, "Naturaleza sin declarar"],
    [{ nature: "work" }, "Renta del trabajo"],
    [{ amountBasis: null }, "Importe sin declarar como real o nominal"],
    [{ amountBasis: "nominal" }, "Importe nominal"],
  ] as const)("excludes %j from figures and explains why", (declaration, warning) => {
    const markup = renderSection({
      monthlySpendingMinor: 220000,
      schedules: [{ ...RENT, ...declaration }],
    });

    expect(markup).toContain(warning);
    // Only the 340 € one-off dividend remains: 340 / 26,400 = 1.3%.
    expect(markup).toContain("1.3 %");
    expect(markup).toContain("1 cobro");
    expect(markup).toContain("Alquiler piso");
  });

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

// ── the declaration door (#1673) ──────────────────────────────────────────────

describe("CobrosSection — the same declaration door as Rentas (#1673)", () => {
  test("declaring here asks for the nature, basis and provenance, nothing preselected for the person", () => {
    const markup = renderSection();
    const checked = (name: string, value: string) =>
      new RegExp(`name="${name}" checked="" value="${value}"`).test(markup);

    expect(checked("nature", "")).toBe(true);
    expect(checked("nature", "passive")).toBe(false);
    expect(checked("amountBasis", "")).toBe(true);
    expect(markup).toContain("De dónde sale la cifra");
    expect(markup).toMatch(/name="provenance" value="official_simulation"/);
    expect(markup).toMatch(/name="provenance" value="user_estimate"/);
    expect(markup).toContain('name="provenanceAsOf" value=""');
  });

  test("every declared income says whether it counts — and a migrated one that it has no provenance", () => {
    const markup = renderSection();

    expect(markup).toContain(">Cuenta<");
    expect(markup).toContain("Cuenta como renta pasiva");
    expect(markup).toContain("Procedencia sin declarar");
    expect(markup).toContain('href="/objetivos/rentas"');
  });

  test("one that does not count says which declaration keeps it out", () => {
    const markup = renderSection({ schedules: [{ ...RENT, nature: null }] });

    expect(markup).toContain(">No cuenta<");
    expect(markup).toContain(
      "Naturaleza sin declarar: esta renta no cuenta en las cifras.",
    );
  });

  test("one that has not started yet counts from its first payment", () => {
    const markup = renderSection({ schedules: [{ ...RENT, startISO: "2027-01-01" }] });

    expect(markup).toContain("Contará como renta pasiva desde el 1 ene 2027");
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

  test("the section is the #cobros fragment target and the declared-row expenses field is labelled", () => {
    const markup = renderSection();

    expect(markup).toContain('id="cobros"');
    // Visible label on the already-declared row — not only the alta form, and not
    // a placeholder standing in for a label (#1510).
    expect(markup).toMatch(/cobrosExpensesForm[\s\S]*?<label[\s\S]*?>Gastos/);
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

// ── the lease terms (#1521) ───────────────────────────────────────────────────

describe("CobrosSection — lease terms (#1521)", () => {
  test("a coupon or a dividend is offered no regime at all", () => {
    // `endISO` on a coupon means exactly what it says, so there is nothing to
    // declare — and a select that decides nothing is worse than no select.
    const markup = renderSection();

    expect(markup).not.toContain('name="leaseRegime"');
    expect(markup).not.toContain('name="saveLease"');
  });

  test("a rented property gets the three selects on the row and on the alta form", () => {
    const markup = renderSection({ showLeaseTerms: true });

    expect(markup).toContain('name="leaseRegime"');
    expect(markup).toContain('name="rentRevision"');
    expect(markup).toContain('name="postMandatoryTermPolicy"');
    expect(markup).toContain('name="saveLease"');
    // Every one of them opens on «Sin declarar»: the form asks, it never guesses.
    expect(markup).toContain("Sin declarar");
  });

  test("with nothing declared the row SAYS the assumption instead of leaving it blank", () => {
    // The whole of #1521: the app used to drop the flat to its rung's default past
    // the end date without a word. The behaviour is unchanged; the silence is not.
    const markup = renderSection({ showLeaseTerms: true });

    expect(markup).toContain("régimen sin declarar");
    expect(markup).toContain("supuesto: nadie lo ha declarado");
  });

  test("a declared renewal is attributed to the owner and prefilled for correction", () => {
    const markup = renderSection({
      schedules: [
        {
          ...RENT,
          endISO: "2026-09-01",
          leaseRegime: "residential_long_term",
          postMandatoryTermPolicy: "renew_same_real_rent",
          rentRevision: "legal_reference",
          rentRevisionReference: "IRAV",
        },
      ],
      showLeaseTerms: true,
    });

    expect(markup).toContain("sigue rentando lo mismo en términos reales");
    expect(markup).toContain("lo has declarado");
    expect(markup).toContain("IRAV");
    expect(markup).toContain('value="residential_long_term" selected');
  });

  test("a nominal rent carries the warning that its yield is not read as real", () => {
    const markup = renderSection({
      schedules: [{ ...RENT, rentRevision: "fixed" }],
      showLeaseTerms: true,
    });

    expect(markup).toContain("no la lee como rentabilidad real");
  });
});

describe("CobrosSection — el doble conteo de una renta ligada (#1675)", () => {
  const SENTENCE =
    "«Plan Indexa» tiene valor y además una renta declarada ligada a él («Renta vitalicia»).";

  test("nombra el cruce junto a las rentas y ofrece reconocerlo como intencional", () => {
    const markup = renderSection({ doubleCount: SENTENCE });

    expect(markup).toContain(SENTENCE);
    expect(markup).toContain('type="hidden" name="code" value="INCOME_DOUBLE_COUNT"');
    expect(markup).toContain('type="hidden" name="entityId" value="h1"');
    expect(markup).toContain("Es intencional");
  });

  test("sin cruce no hay aviso ni botón", () => {
    const markup = renderSection();

    expect(markup).not.toContain("INCOME_DOUBLE_COUNT");
    expect(markup).not.toContain("Es intencional");
  });
});

describe("Cobros — a holding that never paid anything (#1830)", () => {
  const EMPTY_LINE = "Este activo no ha pagado nada todavía.";

  function renderRecord(over: Partial<CobrosProps> = {}) {
    return renderToStaticMarkup(
      <CobrosRecord
        acknowledgeWarningAction={noop}
        createIncomeAction={noop}
        createPayoutAction={noop}
        currency="EUR"
        currentUrl="/patrimonio/h1/editar?pestaña=cobros"
        deletePayoutAction={noop}
        deletePayoutScheduleAction={noop}
        doubleCount={null}
        holdingId="h1"
        monthlySpendingMinor={220000}
        payouts={[]}
        privacyMode={false}
        schedules={[]}
        showLeaseTerms={false}
        today={TODAY}
        updatePayoutScheduleAction={noop}
        {...over}
      />,
    );
  }

  test("the record says so in one line, with the door to add one, instead of a block of zeros", () => {
    const markup = renderRecord({
      addLink: <a href="/patrimonio/h1/editar?accion=cobro">Añadir un cobro</a>,
    });

    expect(markup).toContain(EMPTY_LINE);
    expect(markup).toContain('href="/patrimonio/h1/editar?accion=cobro"');
    // Not the renta-pasiva strip at 0 €, nor a 0,0 % coverage of the spending, nor
    // a year of empty months.
    expect(markup).not.toContain("Renta pasiva");
    expect(markup).not.toContain("de tu gasto declarado");
    expect(markup).not.toContain("cobrosPasiva");
    expect(markup).not.toContain("0,00 €");
    // Still the `#cobros` fragment `holdingCobrosHref` lands on.
    expect(markup).toContain('id="cobros"');
  });

  test("a refusal of the entry form still prints on the empty record", () => {
    const markup = renderRecord({ error: "El importe tiene que ser positivo." });

    expect(markup).toContain("El importe tiene que ser positivo.");
    expect(markup).toContain(EMPTY_LINE);
  });

  test("on the accordion ficha the line stands alone: the entry forms are right below", () => {
    const markup = renderSection({ payouts: [], schedules: [] });

    expect(markup).toContain(EMPTY_LINE);
    expect(markup).not.toContain("Renta pasiva");
    expect(markup).toContain("Registrar un cobro puntual");
  });

  test("a declared recurring income is not «nothing»: the record keeps its strip", () => {
    const markup = renderRecord({ schedules: [RENT] });

    expect(markup).not.toContain(EMPTY_LINE);
    expect(markup).toContain("Renta pasiva");
    expect(markup).toContain("Alquiler piso");
  });
});
