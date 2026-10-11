/**
 * Tests for fireSustainableSpending (#1428).
 * Run: cd packages/domain && npx vitest run fire-sustainable-spending
 */
import { describe, expect, it } from "vitest";

import type { FireContext, FireScopeConfig } from "./fire";
import type { FireCapitalAvailability } from "./fire-capital-availability";
import { splitFireCapital } from "./fire-capital-split";
import type { FireRentReturnReport } from "./fire-rent-return";
import type {
  FireStandaloneIncome,
  FireStandaloneIncomeReport,
} from "./fire-standalone-income";
import { NO_STANDALONE_INCOMES } from "./fire-standalone-income";
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

/** Nadie ha declarado nada, resuelto contra un día: el estado por defecto. */
const NO_AVAILABILITY: FireCapitalAvailability = {
  declaredMinor: 0,
  lockedMinor: 0,
  resolved: true,
  tranches: [],
  undeclaredMinor: 0,
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
    availability?: FireCapitalAvailability;
    standaloneIncomes?: FireStandaloneIncomeReport;
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
    // Siempre presente: el motor lo produce siempre, y dejarlo opcional aquí abriría
    // un camino que producción no tiene.
    availability: overrides.availability ?? NO_AVAILABILITY,
    capitalSplit,
    context,
    rentReturns: {
      ...NO_RENTS,
      ...(overrides.netRentAnnualMinor === undefined
        ? {}
        : { netRentAnnualMinor: overrides.netRentAnnualMinor }),
    },
    standaloneIncomes: overrides.standaloneIncomes ?? NO_STANDALONE_INCOMES,
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
      limitedByAvailability: false,
      total: { annualMinor: 578_524, monthlyMinor: 48_210 },
      untilAge: 90,
      years: 27,
    });
    expect(spending.depletion!.capital.annualMinor).toBeGreaterThan(
      spending.perpetual.capital.annualMinor,
    );
  });

  it("no reparte capital cuya fecha de disponibilidad es posterior al año (#1528)", () => {
    const locked = fireSustainableSpending(
      result({
        availability: {
          declaredMinor: 6_000_000,
          lockedMinor: 6_000_000,
          resolved: true,
          tranches: [{ amountMinor: 6_000_000, yearsUntil: 10 }],
          undeclaredMinor: 0,
        },
        config: { capitalLastsUntilAge: 90 },
      }),
    )!;

    expect(locked.depletion!.limitedByAvailability).toBe(true);
    // Los 9 primeros años solo pueden salir de los 40.000 € que no están a plazo.
    expect(locked.depletion!.capital.annualMinor).toBe(
      Math.round((4_000_000 * 0.035) / (1 - 1.035 ** -9)),
    );
    // La perpetua no reparte nada por años, así que la fecha no la toca.
    expect(locked.perpetual.capital.annualMinor).toBe(350_000);
  });

  it("sin declaración de disponibilidad la cifra no se mueve ni un céntimo (#1528)", () => {
    const declaredNothing = fireSustainableSpending(
      result({
        availability: {
          declaredMinor: 0,
          lockedMinor: 0,
          resolved: true,
          tranches: [],
          undeclaredMinor: 497_955,
        },
        config: { capitalLastsUntilAge: 90 },
      }),
    )!;

    expect(declaredNothing.depletion!.capital.annualMinor).toBe(578_524);
    expect(declaredNothing.depletion!.limitedByAvailability).toBe(false);
    // El hueco viaja con la cifra: la tarjeta lo nombra en vez de callarlo.
    expect(declaredNothing.availability.undeclaredMinor).toBe(497_955);
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

// ── las rentas sin activo (#1674, S3 de #1522) ─────────────────────────────────

/** La pensión de la simulación oficial de Jorge: 3.383,56 €/mes desde dic 2030. */
function pension(overrides: Partial<FireStandaloneIncome> = {}): FireStandaloneIncome {
  return {
    annualMinor: 4_060_272,
    assumedContributionThrough: null,
    endISO: null,
    incomeId: "inc-pension",
    label: "Pensión",
    provenance: "official_simulation",
    provenanceAsOf: "2026-08-18",
    startISO: "2030-12-10",
    startsLater: true,
    ...overrides,
  };
}

/** Nacido en noviembre de 1963: a los 67 se jubila en noviembre de 2030. */
const BORN_NOV_1963 = { birthMonth: 11, birthYear: 1963 };

function withIncomes(
  readable: FireStandaloneIncome[],
  options: {
    base?: FireScopeConfig;
    config?: Partial<FireScopeConfig>;
    referenceBirth?: FireStandaloneIncomeReport["referenceBirth"];
    netRentAnnualMinor?: number;
  } = {},
) {
  return fireSustainableSpending(
    result({
      ...(options.base === undefined ? {} : { base: options.base }),
      ...(options.config === undefined ? {} : { config: options.config }),
      ...(options.netRentAnnualMinor === undefined
        ? {}
        : { netRentAnnualMinor: options.netRentAnnualMinor }),
      standaloneIncomes: {
        readable,
        referenceBirth:
          options.referenceBirth === undefined ? BORN_NOV_1963 : options.referenceBirth,
        withheld: [],
      },
    }),
  )!;
}

describe("fireSustainableSpending — sin rentas sin activo, nada cambia", () => {
  it("el informe vacío deja cada cifra donde estaba y las cuatro listas vacías", () => {
    const spending = fireSustainableSpending(result({ netRentAnnualMinor: 1_175_000 }))!;

    expect(spending.perpetual.total).toEqual({
      annualMinor: 1_525_000,
      monthlyMinor: 127_083,
    });
    expect(spending.incomes).toEqual({
      conditionBroken: [],
      current: [],
      upcoming: [],
      withheld: [],
    });
  });
});

describe("fireSustainableSpending — la renta vigente hoy entra en las rentas", () => {
  it("suma al total de las dos versiones, sin tocar el capital ni el alquiler", () => {
    const today = pension({
      annualMinor: 1_200_000,
      startISO: "2024-01-01",
      startsLater: false,
    });
    const spending = withIncomes([today], {
      config: { capitalLastsUntilAge: 90 },
      netRentAnnualMinor: 1_175_000,
    });
    const without = withIncomes([], {
      config: { capitalLastsUntilAge: 90 },
      netRentAnnualMinor: 1_175_000,
    });

    expect(spending.incomes.current).toEqual([
      { annualMinor: 1_200_000, condition: null, income: today, monthlyMinor: 100_000 },
    ]);
    // 3.500 € del capital + 11.750 € de alquiler + 12.000 € de la pensión vigente.
    expect(spending.perpetual.total).toEqual({
      annualMinor: 2_725_000,
      monthlyMinor: 227_083,
    });
    expect(spending.perpetual.capital).toEqual(without.perpetual.capital);
    expect(spending.rents).toEqual(without.rents);
    expect(spending.depletion!.total.annualMinor).toBe(
      without.depletion!.total.annualMinor + 1_200_000,
    );
  });
});

describe("fireSustainableSpending — la renta futura es la tercera línea, con fecha", () => {
  it("se enseña aparte, al mes, y no se suma a ninguna cifra de hoy", () => {
    const spending = withIncomes([pension()]);
    const without = withIncomes([]);

    expect(spending.incomes.upcoming).toEqual([
      {
        annualMinor: 4_060_272,
        condition: null,
        income: pension(),
        monthlyMinor: 338_356,
      },
    ]);
    expect(spending.perpetual).toEqual(without.perpetual);
    expect(spending.incomes.current).toEqual([]);
  });
});

describe("fireSustainableSpending — la condición se comprueba contra la jubilación declarada", () => {
  it("cotizar hasta el mes en que se jubila se sostiene, y la cifra la nombra", () => {
    const spending = withIncomes([pension({ assumedContributionThrough: "2030-11-30" })]);

    expect(spending.incomes.upcoming[0]?.condition).toEqual({
      state: "holds",
      throughISO: "2030-11-30",
    });
    expect(spending.incomes.conditionBroken).toEqual([]);
  });

  it("una jubilación declarada anterior la rompe: la renta sale de la tarjeta y dice cuándo se jubila", () => {
    const income = pension({ assumedContributionThrough: "2030-11-30" });
    const spending = withIncomes([income], { config: { targetRetirementAge: 66 } });

    expect(spending.incomes.upcoming).toEqual([]);
    expect(spending.incomes.conditionBroken).toEqual([
      {
        annualMinor: 4_060_272,
        income,
        monthlyMinor: 338_356,
        retirement: { age: 66, month: 11, year: 2029 },
        throughISO: "2030-11-30",
      },
    ]);
  });

  it("una vigente con la condición rota también sale del total", () => {
    const income = pension({
      annualMinor: 1_200_000,
      assumedContributionThrough: "2027-06-30",
      startISO: "2024-01-01",
      startsLater: false,
    });
    const spending = withIncomes([income], { config: { targetRetirementAge: 62 } });

    expect(spending.incomes.current).toEqual([]);
    expect(spending.incomes.conditionBroken).toHaveLength(1);
    expect(spending.perpetual.total).toEqual(spending.perpetual.capital);
  });

  it("con solo el año de nacimiento, el mismo año no la rompe: no se inventa el mes", () => {
    const spending = withIncomes(
      [pension({ assumedContributionThrough: "2030-11-30" })],
      {
        referenceBirth: { birthYear: 1963 },
      },
    );
    const later = withIncomes([pension({ assumedContributionThrough: "2031-01-31" })], {
      referenceBirth: { birthYear: 1963 },
    });

    expect(spending.incomes.upcoming[0]?.condition?.state).toBe("holds");
    expect(later.incomes.conditionBroken[0]?.retirement).toEqual({
      age: 67,
      month: null,
      year: 2030,
    });
  });

  it("sin edad de jubilación declarada no se compara con ninguna: se enseña nombrando lo que falta", () => {
    const { targetRetirementAge: _declared, ...undeclared } = BASE_CONFIG;
    const spending = withIncomes(
      [pension({ assumedContributionThrough: "2030-11-30" })],
      {
        base: undeclared,
      },
    );

    expect(spending.incomes.upcoming[0]?.condition).toEqual({
      missing: "retirement_age",
      state: "unchecked",
      throughISO: "2030-11-30",
    });
  });

  it("con la edad declarada y sin fecha de nacimiento, lo que falta es la fecha", () => {
    const spending = withIncomes(
      [pension({ assumedContributionThrough: "2030-11-30" })],
      {
        referenceBirth: null,
      },
    );

    expect(spending.incomes.upcoming[0]?.condition).toEqual({
      missing: "birth_date",
      state: "unchecked",
      throughISO: "2030-11-30",
    });
  });
});

describe("fireSustainableSpending — las rentas sin activo que no entran", () => {
  it("viajan con su razón tal como las dejó el informe", () => {
    const withheld = [
      { incomeId: "inc-nomina", label: "Nómina", reason: "work_income" as const },
    ];
    const spending = fireSustainableSpending(
      result({ standaloneIncomes: { ...NO_STANDALONE_INCOMES, withheld } }),
    )!;

    expect(spending.incomes.withheld).toEqual(withheld);
  });
});
