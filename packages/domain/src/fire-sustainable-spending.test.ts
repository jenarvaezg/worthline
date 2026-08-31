/**
 * Tests for fireSustainableSpending (#1428).
 * Run: cd packages/domain && npx vitest run fire-sustainable-spending
 */
import { describe, expect, it } from "vitest";

import type { FireContext, FireScopeConfig } from "./fire";
import { splitFireCapital } from "./fire-capital-split";
import type { FireRentReturnReport } from "./fire-rent-return";
import { fireSustainableSpending } from "./fire-sustainable-spending";

/** 100.000 € vendibles y 370.000 € de ladrillo: la forma de la cartera de Jorge. */
const BASE_CONFIG: FireScopeConfig = {
  currentAge: 63,
  monthlySavingsCapacityMinor: 0,
  monthlySpendingMinor: 200_000,
  safeWithdrawalRate: 0.035,
  expectedRealReturn: 0.035,
  targetRetirementAge: 67,
};

const NO_RENTS: FireRentReturnReport = {
  applied: [],
  netRentAnnualMinor: 0,
  notices: [],
};

/** La misma cartera sin edad de referencia: sin fecha de nacimiento no hay reloj. */
const AGELESS_CONFIG: FireScopeConfig = {
  monthlySavingsCapacityMinor: 0,
  monthlySpendingMinor: 200_000,
  safeWithdrawalRate: 0.035,
  expectedRealReturn: 0.035,
  targetRetirementAge: 67,
};

function result(
  overrides: {
    base?: FireScopeConfig;
    config?: Partial<FireScopeConfig>;
    netRentAnnualMinor?: number;
    realReturnUsed?: number;
    countsImmobilized?: boolean;
    reservedForGoalsMinor?: number;
  } = {},
) {
  const config: FireScopeConfig = {
    ...(overrides.base ?? BASE_CONFIG),
    ...overrides.config,
  };
  const capitalSplit = splitFireCapital({
    eligibleByTierMinor: { cash: 2_000_000, market: 8_000_000, housing: 37_000_000 },
    debtByTierMinor: {},
    ...(overrides.countsImmobilized === undefined
      ? {}
      : { countsImmobilized: overrides.countsImmobilized }),
    ...(overrides.reservedForGoalsMinor === undefined
      ? {}
      : { reservedForGoalsMinor: overrides.reservedForGoalsMinor }),
  });
  const context: FireContext = {
    config,
    currency: "EUR",
    realReturnUsed: overrides.realReturnUsed ?? config.expectedRealReturn ?? 0.05,
    effectiveRealReturn: config.expectedRealReturn ?? 0.05,
    eligibleMinor: capitalSplit.drawableMinor,
    eligibleGrossMinor: capitalSplit.drawableMinor,
    fireNumberMinor: Math.round(
      (config.monthlySpendingMinor * 12) / config.safeWithdrawalRate,
    ),
  };
  return {
    capitalSplit,
    context,
    rentReturns: {
      ...NO_RENTS,
      ...(overrides.netRentAnnualMinor === undefined
        ? {}
        : { netRentAnnualMinor: overrides.netRentAnnualMinor }),
    },
  };
}

describe("fireSustainableSpending — la parte del capital", () => {
  it("es lo VENDIBLE por la tasa de retirada, nunca el pool entero", () => {
    const spending = fireSustainableSpending(result())!;

    // 100.000 € × 3,5 % = 3.500 €/año. El ladrillo no se gasta a plazos, así que no
    // entra aquí ni cuando cuenta como capital FIRE.
    expect(spending.perpetual.capital).toEqual({
      annualMinor: 350_000,
      monthlyMinor: 29_167,
    });
    expect(spending.sellableMinor).toBe(10_000_000);
  });

  it("la declaración sobre el inmovilizado no la mueve: ese capital nunca estaba dentro", () => {
    const counting = fireSustainableSpending(result({ countsImmobilized: true }))!;
    const notCounting = fireSustainableSpending(result({ countsImmobilized: false }))!;

    expect(notCounting.perpetual.capital).toEqual(counting.perpetual.capital);
  });

  it("una reserva por metas sí la mueve: ese capital ya está comprometido", () => {
    const spending = fireSustainableSpending(
      result({ reservedForGoalsMinor: 5_000_000 }),
    )!;

    expect(spending.sellableMinor).toBe(5_000_000);
    expect(spending.perpetual.capital.annualMinor).toBe(175_000);
  });

  it("sin tasa de retirada no hay nada honesto que dividir", () => {
    expect(
      fireSustainableSpending(result({ config: { safeWithdrawalRate: 0 } })),
    ).toBeNull();
  });
});

describe("fireSustainableSpending — las rentas van aparte", () => {
  it("suma las rentas netas al total, y las mantiene como su propia mitad", () => {
    const spending = fireSustainableSpending(result({ netRentAnnualMinor: 1_175_000 }))!;

    expect(spending.rents).toEqual({ annualMinor: 1_175_000, monthlyMinor: 97_917 });
    expect(spending.perpetual.total).toEqual({
      annualMinor: 1_525_000,
      monthlyMinor: 127_083,
    });
  });

  it("sin rentas declaradas la mitad no existe, y el total es el capital", () => {
    const spending = fireSustainableSpending(result())!;

    expect(spending.rents).toBeNull();
    expect(spending.perpetual.total).toEqual(spending.perpetual.capital);
  });
});

describe("fireSustainableSpending — la versión de agotamiento", () => {
  it("anualiza el capital vendible hasta la edad final declarada", () => {
    const spending = fireSustainableSpending(
      result({ config: { capitalLastsUntilAge: 90 } }),
    )!;

    // 100.000 € al 3,5 % repartidos en 27 años: más que el perpetuo, porque el
    // principal se gasta.
    expect(spending.depletion).toEqual({
      capital: { annualMinor: 578_524, monthlyMinor: 48_210 },
      total: { annualMinor: 578_524, monthlyMinor: 48_210 },
      untilAge: 90,
      years: 27,
    });
    expect(spending.depletion!.capital.annualMinor).toBeGreaterThan(
      spending.perpetual.capital.annualMinor,
    );
  });

  it("las rentas se suman también aquí: no se agotan con el capital", () => {
    const spending = fireSustainableSpending(
      result({ config: { capitalLastsUntilAge: 90 }, netRentAnnualMinor: 1_175_000 }),
    )!;

    expect(spending.depletion!.total.annualMinor).toBe(578_524 + 1_175_000);
  });

  it("con retorno cero es un reparto lineal, no una división por cero", () => {
    const spending = fireSustainableSpending(
      result({ config: { capitalLastsUntilAge: 83 }, realReturnUsed: 0 }),
    )!;

    expect(spending.depletion!.capital).toEqual({
      annualMinor: 500_000,
      monthlyMinor: 41_667,
    });
  });

  it("sin edad final declarada no hay versión de agotamiento: no se inventa una edad", () => {
    const spending = fireSustainableSpending(result())!;

    expect(spending.depletion).toBeNull();
    expect(spending.depletionAbsence).toBe("no_final_age");
  });

  it("una edad final ya alcanzada no deja años que repartir, y lo dice así", () => {
    for (const capitalLastsUntilAge of [63, 50]) {
      const spending = fireSustainableSpending(
        result({ config: { capitalLastsUntilAge } }),
      )!;

      expect(spending.depletion).toBeNull();
      expect(spending.depletionAbsence).toBe("final_age_reached");
    }
  });

  it("con la edad final puesta y sin fecha de nacimiento, el hueco es la OTRA falta", () => {
    // Si esto dijera «no_final_age», la tarjeta pediría un dato que el usuario ya dio.
    const spending = fireSustainableSpending(
      result({ base: AGELESS_CONFIG, config: { capitalLastsUntilAge: 90 } }),
    )!;

    expect(spending.depletion).toBeNull();
    expect(spending.depletionAbsence).toBe("no_reference_age");
  });

  it("con la versión de agotamiento presente no hay hueco que explicar", () => {
    expect(
      fireSustainableSpending(result({ config: { capitalLastsUntilAge: 90 } }))!
        .depletionAbsence,
    ).toBeNull();
  });
});

describe("la declaración del servicio de deuda no mueve ninguna cifra (#1520)", () => {
  it("las tres respuestas producen exactamente el mismo gasto sostenible", () => {
    const undeclared = fireSustainableSpending(result())!;
    const included = fireSustainableSpending(
      result({ config: { monthlySpendingIncludesDebtService: true } }),
    )!;
    const excluded = fireSustainableSpending(
      result({ config: { monthlySpendingIncludesDebtService: false } }),
    )!;

    // La opción de RESTAR la cuota se dejó fuera a propósito (ADR 0099): este ticket
    // nombra el supuesto y mide el testigo. Si alguna vez una de estas tres cifras se
    // separa de las otras, es que la resta entró por la puerta de atrás.
    expect(included).toEqual(undeclared);
    expect(excluded).toEqual(undeclared);
  });
});
