/**
 * What every declared income says about itself (#1673): whether it is counting,
 * and why not when it is not — the same sentence on the Rentas list and on the
 * holding's ficha. Pure.
 */

import type { Income } from "@worthline/domain";
import { describe, expect, test } from "vitest";

import {
  incomeConditionLine,
  incomeCountingStatus,
  incomeDeclarationLine,
  incomeProvenanceLine,
  incomeWindowLine,
  sortIncomesForDisplay,
} from "./income-view";

const TODAY = "2026-10-11";

function income(over: Partial<Income> = {}): Income {
  return {
    id: "inc_1",
    holdingId: "asset_flat",
    nature: "passive",
    amountBasis: "real",
    assumedContributionThrough: null,
    provenance: null,
    provenanceAsOf: null,
    label: "Alquiler",
    amountMinor: 90_000,
    expensesMinor: null,
    cadence: "monthly",
    startISO: "2024-01-01",
    endISO: null,
    exclusions: [],
    ...over,
  };
}

describe("incomeCountingStatus", () => {
  test("a linked passive income in today's euros counts", () => {
    expect(incomeCountingStatus(income(), TODAY)).toEqual({
      counts: true,
      mark: "Cuenta",
      text: "Cuenta como renta pasiva: sus cobros de los últimos 12 meses suman en la renta pasiva de su activo.",
    });
  });

  test("one that ended inside the 12-month window still counts what it paid", () => {
    expect(incomeCountingStatus(income({ endISO: "2026-06-01" }), TODAY)).toEqual({
      counts: true,
      mark: "Cuenta",
      text: "Terminó el 1 jun 2026: sus cobros hasta esa fecha aún suman en la renta pasiva de los últimos 12 meses.",
    });
  });

  test("one that ended years ago says it no longer adds anything", () => {
    expect(incomeCountingStatus(income({ endISO: "2022-03-01" }), TODAY)).toEqual({
      counts: false,
      mark: "No cuenta",
      text: "Terminó el 1 mar 2022: ya no le queda ningún cobro en la renta pasiva de los últimos 12 meses.",
    });
  });

  test("one whose every recent payment was excluded says it adds nothing now", () => {
    const status = incomeCountingStatus(
      income({ cadence: "annual", startISO: "2024-01-01", exclusions: ["2026-01-01"] }),
      TODAY,
    );

    expect(status).toEqual({
      counts: false,
      mark: "No cuenta",
      text: "Ningún cobro suyo cae en los últimos 12 meses: ahora mismo no suma en la renta pasiva.",
    });
  });

  test("one whose holding is in the Papelera does not count while it stays there", () => {
    expect(incomeCountingStatus(income(), TODAY, { holdingInTrash: true })).toEqual({
      counts: false,
      mark: "No cuenta",
      text: "Su activo está en la Papelera: mientras siga allí, sus cobros no suman en ninguna cifra.",
    });
  });

  test("a linked one that has not started counts from its first payment, not before", () => {
    expect(incomeCountingStatus(income({ startISO: "2030-11-01" }), TODAY)).toEqual({
      counts: true,
      mark: "Contará",
      text: "Contará como renta pasiva desde el 1 nov 2030; hasta entonces no suma ningún cobro.",
    });
  });

  test("an undeclared nature does not count, and says so", () => {
    expect(incomeCountingStatus(income({ nature: null }), TODAY)).toEqual({
      counts: false,
      mark: "No cuenta",
      text: "Naturaleza sin declarar: esta renta no cuenta en las cifras.",
    });
  });

  test("work income and a nominal amount each name their own reason", () => {
    expect(incomeCountingStatus(income({ nature: "work" }), TODAY).text).toBe(
      "Renta del trabajo: no cuenta como renta pasiva.",
    );
    expect(incomeCountingStatus(income({ amountBasis: "nominal" }), TODAY).text).toBe(
      "Importe nominal: esta renta no se cuenta como euros de hoy en las cifras.",
    );
  });

  // #1674: el gasto sostenible lee las rentas sin activo. Hasta S3 esta frase decía
  // que ninguna cifra las leía, y era verdad; ahora diría lo contrario de la tarjeta.
  test("an income without an asset in force today counts in the sustainable spending", () => {
    expect(incomeCountingStatus(income({ holdingId: null }), TODAY)).toEqual({
      counts: true,
      mark: "Cuenta",
      text: "Cuenta en tu gasto sostenible: suma a tus rentas netas.",
    });
  });

  test("one without an asset that starts later is the dated line, and names the condition it rests on", () => {
    expect(
      incomeCountingStatus(
        income({
          assumedContributionThrough: "2030-10-31",
          holdingId: null,
          startISO: "2030-11-01",
        }),
        TODAY,
      ),
    ).toEqual({
      counts: true,
      mark: "Contará",
      text: "Contará en tu gasto sostenible desde el 1 nov 2030, como una línea con fecha que no se suma a lo de hoy. Si declaras jubilarte antes de lo que supone cotizar, sale de la tarjeta.",
    });
  });

  test("one without an asset that has ended adds nothing any more", () => {
    expect(
      incomeCountingStatus(income({ endISO: "2025-12-31", holdingId: null }), TODAY),
    ).toEqual({
      counts: false,
      mark: "No cuenta",
      text: "Terminó el 31 dic 2025: ya no suma en tu gasto sostenible.",
    });
  });

  test("a missing declaration is named before the missing asset — it is the fixable one", () => {
    expect(
      incomeCountingStatus(income({ holdingId: null, amountBasis: null }), TODAY).text,
    ).toBe(
      "Importe sin declarar como real o nominal: esta renta no cuenta en las cifras.",
    );
  });
});

describe("incomeDeclarationLine", () => {
  test("names both declarations", () => {
    expect(incomeDeclarationLine(income())).toBe("Pasiva · importe en euros de hoy");
    expect(
      incomeDeclarationLine(income({ nature: "work", amountBasis: "nominal" })),
    ).toBe("Del trabajo · importe en euros de cada cobro");
  });

  test("says «sin declarar» instead of leaving a blank", () => {
    expect(incomeDeclarationLine(income({ nature: null, amountBasis: null }))).toBe(
      "Naturaleza sin declarar · importe sin declarar",
    );
  });
});

describe("incomeProvenanceLine", () => {
  test("names the source and the date of its data", () => {
    expect(
      incomeProvenanceLine(
        income({ provenance: "official_simulation", provenanceAsOf: "2026-08-18" }),
      ),
    ).toBe("Simulación oficial, con datos a 18 ago 2026");
  });

  test("an income declared before the door existed says it has none", () => {
    expect(incomeProvenanceLine(income())).toBe("Procedencia sin declarar");
  });
});

describe("incomeWindowLine", () => {
  test("names the cadence and an open window", () => {
    expect(incomeWindowLine(income({ startISO: "2030-11-01" }))).toBe(
      "Mensual · desde 1 nov 2030",
    );
  });

  test("names a closed window by both ends", () => {
    expect(
      incomeWindowLine(
        income({ cadence: "annual", startISO: "2024-01-01", endISO: "2026-02-01" }),
      ),
    ).toBe("Anual · 1 ene 2024 – 1 feb 2026");
  });
});

describe("sortIncomesForDisplay", () => {
  test("incomes with no asset first, then by start date and concept — a fresh copy", () => {
    const base = [
      income({
        id: "a",
        holdingId: "asset_flat",
        startISO: "2020-01-01",
        label: "Alquiler",
      }),
      income({ id: "b", holdingId: null, startISO: "2030-11-01", label: "Pensión" }),
      income({ id: "c", holdingId: null, startISO: "2025-01-01", label: "Nómina" }),
      income({
        id: "d",
        holdingId: "asset_bond",
        startISO: "2020-01-01",
        label: "Cupón",
      }),
    ];

    expect(sortIncomesForDisplay(base).map((row) => row.id)).toEqual([
      "c",
      "b",
      "a",
      "d",
    ]);
    expect(base.map((row) => row.id)).toEqual(["a", "b", "c", "d"]);
  });
});

describe("incomeConditionLine", () => {
  test("names the condition when there is one", () => {
    expect(
      incomeConditionLine(income({ assumedContributionThrough: "2030-10-31" })),
    ).toBe("Supone seguir cotizando hasta el 31 oct 2030");
  });

  test("is absent when none was declared", () => {
    expect(incomeConditionLine(income())).toBeNull();
  });
});
