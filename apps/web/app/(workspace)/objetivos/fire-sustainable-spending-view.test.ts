import type { FireRetirementProfile, FireSustainableSpending } from "@worthline/domain";
import { describe, expect, test } from "vitest";

import {
  fireOrdinaryPlanNote,
  fireRetirementOfferLine,
  fireSustainableSpendingCopy,
} from "./fire-sustainable-spending-view";

/** Euros en unidades menores, sin separadores: el test lee la aritmética, no el locale. */
const formatMoney = (amountMinor: number) => `${(amountMinor / 100).toFixed(2)} €`;

function spending(
  overrides: Partial<FireSustainableSpending> = {},
): FireSustainableSpending {
  return {
    depletion: null,
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
      hasRentsPendingExpenses: false,
      immobilizedMinor: 0,
      spending: spending(),
    });

    expect(copy.headline).toBe("291.67 €/mes");
    expect(copy.headlineAnnual).toBe("3500.00 €/año");
  });

  test("la mitad del capital cita su propia aritmética: vendible × tasa ÷ 12", () => {
    const copy = fireSustainableSpendingCopy({
      formatMoney,
      hasRentsPendingExpenses: false,
      immobilizedMinor: 0,
      spending: spending(),
    });

    expect(copy.rows).toHaveLength(1);
    expect(copy.rows[0]).toEqual({
      gloss: "100000.00 € de capital vendible × 3,5 % ÷ 12",
      key: "capital",
      label: "Lo que soporta tu capital",
      value: "291.67 €/mes",
    });
  });

  test("con rentas hay dos mitades, y las rentas van primero", () => {
    const copy = fireSustainableSpendingCopy({
      formatMoney,
      hasRentsPendingExpenses: false,
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
      hasRentsPendingExpenses: false,
      immobilizedMinor: 0,
      spending: spending({
        depletion: {
          capital: { annualMinor: 578_524, monthlyMinor: 48_210 },
          total: { annualMinor: 578_524, monthlyMinor: 48_210 },
          untilAge: 90,
          years: 27,
        },
      }),
    });

    expect(copy.depletion?.value).toBe("482.10 €/mes");
    expect(copy.depletion?.gloss).toContain("hasta los 90 (27 años)");
    expect(copy.depletion?.gloss).toContain("el principal se gasta");
  });

  test("sin edad final no hay segunda cifra", () => {
    expect(
      fireSustainableSpendingCopy({
        formatMoney,
        hasRentsPendingExpenses: false,
        immobilizedMinor: 0,
        spending: spending(),
      }).depletion,
    ).toBeNull();
  });

  test("el patrimonio inmovilizado se nombra: no está en la cifra, y por eso hay que decirlo", () => {
    const copy = fireSustainableSpendingCopy({
      formatMoney,
      hasRentsPendingExpenses: false,
      immobilizedMinor: 37_000_000,
      spending: spending(),
    });

    expect(copy.exclusionNote).toContain("370000.00 €");
    expect(copy.exclusionNote).toContain("no se gastan a plazos");
  });

  test("un alquiler sin gastos declarados se dice, porque vale 0 hasta que se declaren", () => {
    const copy = fireSustainableSpendingCopy({
      formatMoney,
      hasRentsPendingExpenses: true,
      immobilizedMinor: 0,
      spending: spending(),
    });

    expect(copy.exclusionNote).toContain("sin gastos");
  });

  test("sin nada que excluir no hay nota", () => {
    expect(
      fireSustainableSpendingCopy({
        formatMoney,
        hasRentsPendingExpenses: false,
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
