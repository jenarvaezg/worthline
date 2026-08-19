/**
 * Tests for fireCoastArrival (#1425).
 * Run: cd packages/domain && npx vitest run fire-coast-arrival
 */
import { describe, expect, it } from "vitest";

import {
  calculateFire,
  type FireContext,
  type FireScopeConfig,
  projectFireFromContext,
} from "./fire";
import { fireCoastArrival } from "./fire-coast-arrival";
import { monthlySavingsCapacityForFire } from "./fire-savings-capacity";

/** Jorge's shape: 63 años, jubilación a 67, 3,5 % real. */
const BASE_CONFIG: FireScopeConfig = {
  currentAge: 63,
  monthlySavingsCapacityMinor: 150_000,
  monthlySpendingMinor: 200_000,
  safeWithdrawalRate: 0.035,
  expectedRealReturn: 0.035,
  targetRetirementAge: 67,
};

function ctx(
  overrides: {
    config?: FireScopeConfig;
    eligibleMinor?: number;
    realReturnUsed?: number;
  } = {},
): FireContext {
  const config = overrides.config ?? BASE_CONFIG;
  const eligibleMinor = overrides.eligibleMinor ?? 0;
  const effectiveRealReturn = config.expectedRealReturn ?? 0.05;
  return {
    config,
    currency: "EUR",
    realReturnUsed: overrides.realReturnUsed ?? effectiveRealReturn,
    effectiveRealReturn,
    eligibleMinor,
    eligibleGrossMinor: eligibleMinor,
    fireNumberMinor: Math.round(
      (config.monthlySpendingMinor * 12) / config.safeWithdrawalRate,
    ),
  };
}

function coastRequiredMinor(context: FireContext): number {
  return calculateFire(
    context.config,
    context.eligibleMinor,
    context.currency,
    context.realReturnUsed,
  ).coastFireRequired!.amountMinor;
}

describe("fireCoastArrival — la edad a la que SÍ se llega a Coast", () => {
  it("es el primer año en que la trayectoria con aportaciones cruza el Coast requerido", () => {
    const context = ctx({ eligibleMinor: 20_000_000 });
    const required = coastRequiredMinor(context);

    const arrival = fireCoastArrival(context);

    expect(arrival?.kind).toBe("eta");
    if (arrival?.kind !== "eta") return;

    // La comprobación es aritmética, no una constante pegada: se re-hace el paso
    // anual del motor y se cuenta cuándo cruza.
    let capital = context.eligibleMinor;
    let crossed: number | null = null;
    for (let year = 1; year <= 60; year += 1) {
      capital = capital * 1.035 + 150_000 * 12;
      if (capital >= required) {
        crossed = year;
        break;
      }
    }
    expect(crossed).not.toBeNull();
    // La edad es la del año de proyección en que se cruza; la glosa lleva la
    // interpolación, que cae dentro de ese año.
    expect(arrival.age).toBe(63 + crossed!);
    expect(arrival.years).toBeLessThanOrEqual(crossed!);
    expect(arrival.years).toBeGreaterThan(crossed! - 1);
  });

  it("aportar más adelanta la llegada a Coast — que es el sentido entero del concepto", () => {
    const stingy = fireCoastArrival(
      ctx({
        config: { ...BASE_CONFIG, monthlySavingsCapacityMinor: 10_000 },
        eligibleMinor: 20_000_000,
      }),
    );
    const generous = fireCoastArrival(
      ctx({
        config: { ...BASE_CONFIG, monthlySavingsCapacityMinor: 250_000 },
        eligibleMinor: 20_000_000,
      }),
    );

    expect(stingy?.kind).toBe("eta");
    expect(generous?.kind).toBe("eta");
    if (stingy?.kind !== "eta" || generous?.kind !== "eta") return;
    expect(generous.years).toBeLessThan(stingy.years);
  });

  it("la edad va a año entero: un decimal en una proyección a diez años finge precisión", () => {
    const arrival = fireCoastArrival(ctx({ eligibleMinor: 20_000_000 }));

    expect(arrival?.kind).toBe("eta");
    if (arrival?.kind !== "eta") return;
    expect(Number.isInteger(arrival.age)).toBe(true);
  });

  it("usa la MISMA convención de edad que la tarjeta de proyección de al lado", () => {
    const context = ctx({ eligibleMinor: 20_000_000 });
    const required = coastRequiredMinor(context);
    const arrival = fireCoastArrival(context);

    // `ageAtFire` del escenario base contra el propio requisito: la edad que imprime
    // la fila ES la que calculó el escenario, no un redondeo aparte de la misma cifra.
    const base = projectFireFromContext(context, {
      fireNumberMinor: required,
      monthlyContributionMinor: monthlySavingsCapacityForFire(context.config),
    }).scenarios.find((scenario) => scenario.label === "base")!;

    expect(arrival?.kind).toBe("eta");
    if (arrival?.kind !== "eta") return;
    expect(arrival.age).toBe(base.ageAtFire);
  });

  it("es un sello, no una edad, cuando ya está en Coast", () => {
    // El Coast requerido de esta config ronda los 590.000 €: con 700.000 € ya está.
    const arrival = fireCoastArrival(ctx({ eligibleMinor: 70_000_000 }));

    expect(arrival).toEqual({ kind: "reached" });
  });

  it("es unreachable cuando ni el retorno ni el ahorro cruzan el Coast en el horizonte", () => {
    // 0,1 % real, sin aportaciones y con 10.000 € frente a un requisito de ~672.000 €:
    // el capital crece, pero no lo bastante en los 60 años de la proyección.
    const arrival = fireCoastArrival(
      ctx({
        config: {
          ...BASE_CONFIG,
          currentAge: 45,
          expectedRealReturn: 0.001,
          monthlySavingsCapacityMinor: 0,
          targetRetirementAge: 65,
        },
        eligibleMinor: 1_000_000,
      }),
    );

    expect(arrival).toEqual({ kind: "unreachable" });
  });

  it("no hay llegada a Coast si no hay Coast: sin margen de composición no hay requisito", () => {
    // Retorno 0 y edad objetivo ya pasada: `calculateFire` no emite el bloque (ADR
    // 0079), así que aquí no hay nada que fechar — ni un «unreachable» que sugiera
    // que con más ahorro se llegaría.
    expect(
      fireCoastArrival(
        ctx({
          config: { ...BASE_CONFIG, expectedRealReturn: 0 },
          eligibleMinor: 20_000_000,
        }),
      ),
    ).toBeNull();
    expect(
      fireCoastArrival(
        ctx({ config: { ...BASE_CONFIG, currentAge: 70 }, eligibleMinor: 20_000_000 }),
      ),
    ).toBeNull();
  });

  it("no hay llegada a Coast si no hay Coast: sin edad no hay horizonte que descontar", () => {
    const { currentAge: _dropped, ...ageless } = BASE_CONFIG;

    expect(
      fireCoastArrival(ctx({ config: ageless, eligibleMinor: 20_000_000 })),
    ).toBeNull();
  });

  it("mide contra el MISMO Coast requerido que calculateFire, no una segunda fórmula", () => {
    // Con capital justo por debajo del requisito la llegada es inmediata (año 1);
    // con capital justo por encima es un sello. La frontera es la misma cifra.
    const context = ctx({ eligibleMinor: 20_000_000 });
    const required = coastRequiredMinor(context);

    expect(fireCoastArrival(ctx({ eligibleMinor: required - 1 }))?.kind).toBe("eta");
    expect(fireCoastArrival(ctx({ eligibleMinor: required }))).toEqual({
      kind: "reached",
    });
  });
});
