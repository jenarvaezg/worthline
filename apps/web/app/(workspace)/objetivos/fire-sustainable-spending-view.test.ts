import type {
  FireRetirementProfile,
  FireStandaloneIncome,
  FireSustainableSpending,
  FireSustainableSpendingIncomes,
  RentReturnNotice,
} from "@worthline/domain";
import { describe, expect, test } from "vitest";

import {
  fireOrdinaryPlanNote,
  firePanelHeading,
  fireRetirementOfferLine,
  fireSustainableSpendingCopy,
} from "./fire-sustainable-spending-view";

/** Euros en unidades menores, sin separadores: el test lee la aritmética, no el locale. */
const formatMoney = (amountMinor: number) => `${(amountMinor / 100).toFixed(2)} €`;

const NO_INCOMES: FireSustainableSpendingIncomes = {
  conditionBroken: [],
  current: [],
  upcoming: [],
  withheld: [],
};

function spending(
  overrides: Partial<FireSustainableSpending> = {},
): FireSustainableSpending {
  return {
    availability: {
      declaredMinor: 0,
      lockedMinor: 0,
      resolved: true,
      tranches: [],
      undeclaredMinor: 0,
    },
    depletion: null,
    depletionAbsence: "no_final_age",
    incomes: NO_INCOMES,
    perpetual: {
      capital: { annualMinor: 350_000, monthlyMinor: 29_167 },
      total: { annualMinor: 350_000, monthlyMinor: 29_167 },
    },
    realReturnUsed: 0.035,
    rents: null,
    sellableMinor: 10_000_000,
    withdrawalRate: 0.035,
    ...overrides,
  };
}

function notice(reason: RentReturnNotice["reason"]): RentReturnNotice {
  const common = { assetId: "asset_flat", assetName: "Piso", grossRate: null };
  // Only `no_live_schedule` carries a window, and this card does not read it: it
  // aggregates reasons, so any declared window will do.
  return reason === "no_live_schedule"
    ? {
        ...common,
        reason,
        scheduleWindow: { endedOnISO: "2026-07-31", startsOnISO: null },
      }
    : { ...common, reason };
}

function profile(overrides: Partial<FireRetirementProfile> = {}): FireRetirementProfile {
  return {
    declared: null,
    ordinaryRetirementAge: 65,
    signals: [],
    state: "fire",
    ...overrides,
  };
}

describe("fireSustainableSpendingCopy", () => {
  test("el titular es el mensual, y lleva su anual al lado", () => {
    const copy = fireSustainableSpendingCopy({
      formatMoney,
      rentNotices: [],
      immobilizedMinor: 0,
      spending: spending(),
    });

    expect(copy.headline).toBe("291.67 €/mes");
    expect(copy.headlineAnnual).toBe("3500.00 €/año");
  });

  test("la mitad del capital cita su propia aritmética: vendible × tasa ÷ 12", () => {
    const copy = fireSustainableSpendingCopy({
      formatMoney,
      rentNotices: [],
      immobilizedMinor: 0,
      spending: spending(),
    });

    expect(copy.rows).toHaveLength(1);
    expect(copy.rows[0]).toEqual({
      gloss: "100000.00 € de capital vendible × 3,5 % ÷ 12",
      id: "capital",
      key: "capital",
      label: "Lo que soporta tu capital",
      value: "291.67 €/mes",
    });
  });

  test("con rentas hay dos mitades, y las rentas van primero", () => {
    const copy = fireSustainableSpendingCopy({
      formatMoney,
      rentNotices: [],
      immobilizedMinor: 0,
      spending: spending({
        perpetual: {
          capital: { annualMinor: 350_000, monthlyMinor: 29_167 },
          total: { annualMinor: 1_525_000, monthlyMinor: 127_083 },
        },
        rents: { annualMinor: 1_175_000, monthlyMinor: 97_917 },
      }),
    });

    expect(copy.rows.map((row) => row.key)).toEqual(["rents", "capital"]);
    expect(copy.rows[0]?.gloss).toContain("alquiler neto declarado");
    expect(copy.headline).toBe("1270.83 €/mes");
  });

  test("la versión de agotamiento dice hasta cuándo dura y que el principal se gasta", () => {
    const copy = fireSustainableSpendingCopy({
      formatMoney,
      rentNotices: [],
      immobilizedMinor: 0,
      spending: spending({
        depletion: {
          capital: { annualMinor: 578_524, monthlyMinor: 48_210 },
          limitedByAvailability: false,
          total: { annualMinor: 578_524, monthlyMinor: 48_210 },
          untilAge: 90,
          years: 27,
        },
        depletionAbsence: null,
      }),
    });

    expect(copy.depletion?.value).toBe("482.10 €/mes");
    expect(copy.depletion?.gloss).toContain("hasta los 90 (27 años)");
    expect(copy.depletion?.gloss).toContain("el principal se gasta");
  });

  test("sin edad final no hay segunda cifra, y el hueco pide el dato que falta", () => {
    const copy = fireSustainableSpendingCopy({
      formatMoney,
      immobilizedMinor: 0,
      rentNotices: [],
      spending: spending(),
    });

    expect(copy.depletion).toBeNull();
    expect(copy.depletionAbsence).toContain("hasta qué edad debe durar tu capital");
  });

  test("con la edad final puesta y sin fecha de nacimiento, pide la fecha — no la edad otra vez", () => {
    const copy = fireSustainableSpendingCopy({
      formatMoney,
      immobilizedMinor: 0,
      rentNotices: [],
      spending: spending({ depletionAbsence: "no_reference_age" }),
    });

    expect(copy.depletionAbsence).toContain("fecha de nacimiento");
    expect(copy.depletionAbsence).not.toContain("hasta qué edad");
  });

  test("una edad final ya alcanzada no pide nada: lo explica", () => {
    const copy = fireSustainableSpendingCopy({
      formatMoney,
      immobilizedMinor: 0,
      rentNotices: [],
      spending: spending({ depletionAbsence: "final_age_reached" }),
    });

    expect(copy.depletionAbsence).toContain("ya ha alcanzado");
  });

  test("el patrimonio inmovilizado se nombra: no está en la cifra, y por eso hay que decirlo", () => {
    const copy = fireSustainableSpendingCopy({
      formatMoney,
      rentNotices: [],
      immobilizedMinor: 37_000_000,
      spending: spending(),
    });

    expect(copy.exclusionNote).toContain("370000.00 €");
    expect(copy.exclusionNote).toContain("no se gastan a plazos");
  });

  test("cada razón por la que un alquiler declarado no suma se dice con sus palabras", () => {
    const copy = fireSustainableSpendingCopy({
      formatMoney,
      immobilizedMinor: 0,
      rentNotices: [
        notice("missing_expenses"),
        notice("no_live_schedule"),
        notice("foreign_currency"),
      ],
      spending: spending(),
    });

    expect(copy.exclusionNote).toContain("les faltan los gastos declarados");
    expect(copy.exclusionNote).toContain("no están vigentes hoy");
    expect(copy.exclusionNote).toContain("divisa");
  });

  test("el aviso del inmovilizado NO cuenta como renta ausente: ese alquiler sí suma", () => {
    // La declaración de #1460 habla de capital, no de ingresos. Anunciar su alquiler
    // como ausente mentiría en la dirección contraria.
    const copy = fireSustainableSpendingCopy({
      formatMoney,
      immobilizedMinor: 0,
      rentNotices: [notice("immobilized_not_counted")],
      spending: spending(),
    });

    expect(copy.exclusionNote).toBeNull();
  });

  test("sin nada que excluir no hay nota", () => {
    expect(
      fireSustainableSpendingCopy({
        formatMoney,
        rentNotices: [],
        immobilizedMinor: 0,
        spending: spending(),
      }).exclusionNote,
    ).toBeNull();
  });
});

describe("fireRetirementOfferLine", () => {
  test("nombra el hecho, no el veredicto", () => {
    const line = fireRetirementOfferLine(
      profile({
        signals: [
          {
            kind: "target_age_is_ordinary",
            ordinaryRetirementAge: 65,
            targetRetirementAge: 67,
          },
        ],
        state: "offer",
      }),
    );

    expect(line).toBe(
      "Parece que tu plan es una jubilación ordinaria: tu edad objetivo son 67 años, no una jubilación anticipada.",
    );
  });

  test("con dos señales las dice las dos", () => {
    const line = fireRetirementOfferLine(
      profile({
        signals: [
          {
            kind: "target_age_is_ordinary",
            ordinaryRetirementAge: 65,
            targetRetirementAge: 67,
          },
          { kind: "regular_unreachable" },
        ],
        state: "offer",
      }),
    );

    expect(line).toContain("67 años");
    expect(line).toContain("no alcanzas tu número FIRE");
  });

  test("fuera del estado de ofrecimiento no se ofrece nada", () => {
    expect(fireRetirementOfferLine(profile({ state: "fire" }))).toBeNull();
    expect(
      fireRetirementOfferLine(
        profile({
          declared: "ordinary",
          signals: [{ kind: "regular_unreachable" }],
          state: "ordinary",
        }),
      ),
    ).toBeNull();
  });
});

describe("fireOrdinaryPlanNote", () => {
  test("el porcentaje financiado no se borra: deja de ser el titular", () => {
    expect(fireOrdinaryPlanNote("68,5 %")).toBe(
      "Tu número FIRE sigue calculado: 68,5 % financiado.",
    );
  });
});

describe("firePanelHeading", () => {
  test("la capa cambia la pregunta del encabezado", () => {
    expect(firePanelHeading({ ordinary: true, previewing: false })).toEqual({
      eyebrow: "cuánto puedes gastar",
      title: "Tu plan de jubilación",
    });
    expect(firePanelHeading({ ordinary: false, previewing: false })).toEqual({
      eyebrow: "objetivo principal",
      title: "Independencia financiera · FIRE",
    });
  });

  test("previsualizando manda el aviso de sin guardar, en los dos estados", () => {
    for (const ordinary of [true, false]) {
      expect(firePanelHeading({ ordinary, previewing: true }).eyebrow).toBe(
        "previsualización · sin guardar",
      );
    }
  });
});

describe("fireSustainableSpendingCopy \u2014 la disponibilidad declarada (#1528)", () => {
  test("cuando un bloqueo recorta el reparto, la tarjeta lo nombra", () => {
    const copy = fireSustainableSpendingCopy({
      formatMoney,
      immobilizedMinor: 0,
      rentNotices: [],
      spending: spending({
        availability: {
          declaredMinor: 6_000_000,
          lockedMinor: 6_000_000,
          resolved: true,
          tranches: [{ amountMinor: 6_000_000, yearsUntil: 9 }],
          undeclaredMinor: 0,
        },
        depletion: {
          capital: { annualMinor: 525_791, monthlyMinor: 43_816 },
          limitedByAvailability: true,
          total: { annualMinor: 525_791, monthlyMinor: 43_816 },
          untilAge: 90,
          years: 27,
        },
        depletionAbsence: null,
      }),
    });

    expect(copy.availabilityNote).toContain("60000.00 \u20ac");
    expect(copy.availabilityNote).toContain("antes de que puedas tocarlo");
  });

  test("el capital a plazo sin fecha es un hueco con su arreglo, no un silencio", () => {
    const copy = fireSustainableSpendingCopy({
      formatMoney,
      immobilizedMinor: 0,
      rentNotices: [],
      spending: spending({
        availability: {
          declaredMinor: 0,
          lockedMinor: 0,
          resolved: true,
          tranches: [],
          undeclaredMinor: 497_955,
        },
      }),
    });

    expect(copy.availabilityNote).toContain("4979.55 \u20ac");
    expect(copy.availabilityNote).toContain("A plazo");
    expect(copy.availabilityNote).toContain("en su ficha");
  });

  test("sin día de lectura lo dice, en vez de callar el bloqueo declarado", () => {
    const copy = fireSustainableSpendingCopy({
      formatMoney,
      immobilizedMinor: 0,
      rentNotices: [],
      spending: spending({
        availability: {
          declaredMinor: 6_000_000,
          lockedMinor: 0,
          resolved: false,
          tranches: [],
          undeclaredMinor: 0,
        },
      }),
    });

    // Sin esto, un llamador que no trajera reloj imprimiría una tarjeta idéntica a la
    // de quien no ha declarado nada (ADR 0100 §5).
    expect(copy.availabilityNote).toContain("60000.00 \u20ac");
    expect(copy.availabilityNote).toContain("no ha situado en el calendario");
  });

  test("sin bloqueo y sin hueco no dice nada: es el caso de casi todo el mundo", () => {
    const copy = fireSustainableSpendingCopy({
      formatMoney,
      immobilizedMinor: 0,
      rentNotices: [],
      spending: spending(),
    });

    expect(copy.availabilityNote).toBeNull();
  });

  // ── La casilla de #1523 que #1528 acabó cumpliendo, atada aquí para que quien toque
  // esta rama sepa qué aceptación de qué ticket está rompiendo. #1523 pedía que la
  // tarjeta avisara «de que los primeros años del reparto cuentan con capital no
  // disponible aún, nombrando el importe»; lo que #1528 hizo es más fuerte —el reparto
  // deja de prometerlo— pero la casilla es la misma, y sigue teniendo que decirse.
  test("la tarjeta nunca calla el capital a plazo que el reparto está tocando (#1523)", () => {
    const conFecha = fireSustainableSpendingCopy({
      formatMoney,
      immobilizedMinor: 0,
      rentNotices: [],
      spending: spending({
        availability: {
          declaredMinor: 1_055_658,
          lockedMinor: 1_055_658,
          resolved: true,
          tranches: [{ amountMinor: 1_055_658, yearsUntil: 4 }],
          undeclaredMinor: 0,
        },
        depletion: {
          capital: { annualMinor: 100_000, monthlyMinor: 8_333 },
          limitedByAvailability: true,
          total: { annualMinor: 100_000, monthlyMinor: 8_333 },
          untilAge: 90,
          years: 27,
        },
        depletionAbsence: null,
      }),
    });
    const sinFecha = fireSustainableSpendingCopy({
      formatMoney,
      immobilizedMinor: 0,
      rentNotices: [],
      spending: spending({
        availability: {
          declaredMinor: 0,
          lockedMinor: 0,
          resolved: true,
          tranches: [],
          undeclaredMinor: 1_055_658,
        },
      }),
    });

    // Declarado o no, el importe se nombra: las dos salidas del escalón lo dicen.
    expect(conFecha.availabilityNote).toContain("10556.58 \u20ac");
    expect(sinFecha.availabilityNote).toContain("10556.58 \u20ac");
  });
});

describe("fireSustainableSpendingCopy — las rentas sin activo (#1674)", () => {
  /** La pensión de la simulación oficial de Jorge. */
  function pension(overrides: Partial<FireStandaloneIncome> = {}): FireStandaloneIncome {
    return {
      annualMinor: 4_060_272,
      assumedContributionThrough: null,
      endISO: null,
      incomeId: "inc_pension",
      label: "Pensión",
      provenance: "official_simulation",
      provenanceAsOf: "2026-08-18",
      startISO: "2030-12-10",
      startsLater: true,
      ...overrides,
    };
  }

  function copyWith(incomes: Partial<FireSustainableSpendingIncomes>) {
    return fireSustainableSpendingCopy({
      formatMoney,
      immobilizedMinor: 0,
      rentNotices: [],
      spending: spending({ incomes: { ...NO_INCOMES, ...incomes } }),
    });
  }

  test("sin ninguna, la tarjeta es la de siempre: ni filas, ni línea con fecha, ni notas", () => {
    const copy = copyWith({});

    expect(copy.rows.map((row) => row.key)).toEqual(["capital"]);
    expect(copy.upcoming).toEqual([]);
    expect(copy.conditionNote).toBeNull();
    expect(copy.exclusionNote).toBeNull();
  });

  test("la vigente es una fila de la mitad de rentas, con su procedencia y su fecha de corte al lado", () => {
    const income = pension({
      annualMinor: 1_200_000,
      startISO: "2024-01-01",
      startsLater: false,
    });
    const copy = copyWith({
      current: [
        { annualMinor: 1_200_000, condition: null, income, monthlyMinor: 100_000 },
      ],
    });

    expect(copy.rows.map((row) => row.key)).toEqual(["income", "capital"]);
    expect(copy.rows[0]).toEqual({
      gloss: "Simulación oficial, con datos a 18 ago 2026",
      id: "income-inc_pension",
      key: "income",
      label: "Pensión",
      value: "1000.00 €/mes",
    });
  });

  test("la futura es la línea con fecha: desde cuándo, cuánto más al mes y de dónde sale", () => {
    const copy = copyWith({
      upcoming: [
        {
          annualMinor: 4_060_272,
          condition: { state: "holds", throughISO: "2030-11-30" },
          income: pension({ assumedContributionThrough: "2030-11-30" }),
          monthlyMinor: 338_356,
        },
      ],
    });

    expect(copy.upcoming).toEqual([
      {
        gloss:
          "Simulación oficial, con datos a 18 ago 2026 · supone seguir cotizando hasta el 30 nov 2030",
        id: "income-inc_pension",
        label: "Pensión",
        value: "3383.56 €/mes más",
        when: "Desde el 10 dic 2030",
      },
    ]);
  });

  test("una futura con final lo dice, y una sin procedencia lo dice en vez de inventarla", () => {
    const copy = copyWith({
      upcoming: [
        {
          annualMinor: 676_712,
          condition: null,
          income: pension({
            endISO: "2063-11-10",
            label: "Paga extra",
            provenance: null,
            provenanceAsOf: null,
            startISO: "2030-11-10",
          }),
          monthlyMinor: 56_393,
        },
      ],
    });

    expect(copy.upcoming[0]).toMatchObject({
      gloss: "Procedencia sin declarar",
      when: "Del 10 nov 2030 al 10 nov 2063",
    });
  });

  test("una condición sin contrastar nombra el dato con el que se contrastaría", () => {
    const line = (missing: "retirement_age" | "birth_date") =>
      copyWith({
        upcoming: [
          {
            annualMinor: 4_060_272,
            condition: { missing, state: "unchecked", throughISO: "2030-11-30" },
            income: pension(),
            monthlyMinor: 338_356,
          },
        ],
      }).upcoming[0]?.gloss;

    expect(line("retirement_age")).toBe(
      "Simulación oficial, con datos a 18 ago 2026 · supone seguir cotizando hasta el 30 nov 2030, y sin edad de jubilación declarada no podemos contrastarlo",
    );
    expect(line("birth_date")).toBe(
      "Simulación oficial, con datos a 18 ago 2026 · supone seguir cotizando hasta el 30 nov 2030, y sin tu fecha de nacimiento no podemos situar tu jubilación para contrastarlo",
    );
  });

  test("la condición rota saca la renta de la tarjeta nombrando la jubilación declarada y el dato que falta", () => {
    const copy = copyWith({
      conditionBroken: [
        {
          annualMinor: 4_060_272,
          income: pension(),
          monthlyMinor: 338_356,
          retirement: { age: 66, month: 11, year: 2029 },
          throughISO: "2030-11-30",
        },
      ],
    });

    expect(copy.upcoming).toEqual([]);
    expect(copy.conditionNote).toBe(
      "«Pensión» no está en esta tarjeta: supone seguir cotizando hasta el 30 nov 2030, y declaraste jubilarte a los 66, en noviembre de 2029. Falta una cifra que suponga dejar de cotizar al jubilarte: una simulación a esa fecha, o tu edad de jubilación corregida.",
    );
  });

  test("con solo el año de nacimiento la jubilación se sitúa en su año, sin inventar el mes", () => {
    const copy = copyWith({
      conditionBroken: [
        {
          annualMinor: 4_060_272,
          income: pension(),
          monthlyMinor: 338_356,
          retirement: { age: 65, month: null, year: 2028 },
          throughISO: "2030-11-30",
        },
      ],
    });

    expect(copy.conditionNote).toContain("declaraste jubilarte a los 65, en 2028.");
  });

  test("las que no entran se nombran con su razón, y la nominal avisa de en qué dirección se equivocaría", () => {
    const copy = copyWith({
      withheld: [
        { incomeId: "a", label: "Nómina", reason: "work_income" },
        { incomeId: "b", label: "Pensión", reason: "nominal_amount" },
        { incomeId: "c", label: "Renta vitalicia", reason: "missing_nature" },
        { incomeId: "d", label: "Usufructo", reason: "missing_amount_basis" },
        { incomeId: "e", label: "Pensión de Ana", reason: "ownerless_in_partial_scope" },
      ],
    });

    expect(copy.exclusionNote).toBe(
      "Rentas sin activo que no suman aquí: «Nómina», porque es renta del trabajo, no vivir de tus activos; «Pensión», porque su importe es nominal: a fecha futura no son euros de hoy, y contarlo como tales sobreestimaría lo que te llegará; «Renta vitalicia», porque su naturaleza está sin declarar; «Usufructo», porque su importe está sin declarar como real o nominal; «Pensión de Ana», porque no tiene dueño declarado y este ámbito no incluye a todos los miembros.",
    );
  });
});
