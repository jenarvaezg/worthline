import type {
  FireRetirementProfile,
  FireSustainableSpending,
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

function spending(
  overrides: Partial<FireSustainableSpending> = {},
): FireSustainableSpending {
  return {
    depletion: null,
    depletionAbsence: "no_final_age",
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
  return { assetId: "asset_flat", assetName: "Piso", grossRate: null, reason };
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
