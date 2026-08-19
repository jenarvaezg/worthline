/**
 * Tests for fireRetirementProfile (#1428).
 * Run: cd packages/domain && npx vitest run fire-retirement-profile
 */
import { describe, expect, it } from "vitest";

import type { FireContext, FireScopeConfig } from "./fire";
import type { FireLevel } from "./fire-levels";
import { fireRetirementProfile } from "./fire-retirement-profile";

/** La forma de Jorge: 63 años, jubilación ordinaria a los 67, 3,5 % real. */
const BASE_CONFIG: FireScopeConfig = {
  currentAge: 63,
  monthlySavingsCapacityMinor: 0,
  monthlySpendingMinor: 200_000,
  safeWithdrawalRate: 0.035,
  expectedRealReturn: 0.035,
  targetRetirementAge: 67,
};

/** Sin edad objetivo declarada: el motor cae a 65, pero el usuario no ha dicho nada. */
const NO_TARGET_AGE_CONFIG: FireScopeConfig = {
  currentAge: 63,
  monthlySavingsCapacityMinor: 0,
  monthlySpendingMinor: 200_000,
  safeWithdrawalRate: 0.035,
  expectedRealReturn: 0.035,
};

/** Sin ahorro declarado: la proyección aporta 0, pero nadie ha rellenado el campo. */
const NO_SAVINGS_CONFIG: FireScopeConfig = {
  currentAge: 63,
  monthlySpendingMinor: 200_000,
  safeWithdrawalRate: 0.035,
  expectedRealReturn: 0.035,
  targetRetirementAge: 50,
};

function ctx(
  overrides: Partial<FireScopeConfig> = {},
  base: FireScopeConfig = BASE_CONFIG,
): FireContext {
  const config: FireScopeConfig = { ...base, ...overrides };
  return {
    config,
    currency: "EUR",
    realReturnUsed: config.expectedRealReturn ?? 0.05,
    effectiveRealReturn: config.expectedRealReturn ?? 0.05,
    eligibleMinor: 46_967_100,
    eligibleGrossMinor: 46_967_100,
    fireNumberMinor: Math.round(
      (config.monthlySpendingMinor * 12) / config.safeWithdrawalRate,
    ),
  };
}

function rail(regularEta: FireLevel["eta"]): FireLevel[] {
  return [
    {
      key: "lean",
      label: "Lean",
      amountMinor: 48_000_000,
      eta: { kind: "eta", years: 3 },
      fundsAnnualMinor: 1_680_000,
      spendingMultiplier: 0.7,
    },
    {
      key: "regular",
      label: "Regular",
      amountMinor: 68_571_429,
      eta: regularEta,
      fundsAnnualMinor: 2_400_000,
      spendingMultiplier: 1,
    },
  ];
}

describe("fireRetirementProfile — señales", () => {
  it("una edad objetivo en la edad ordinaria o por encima es señal: no hay «early» en el plan", () => {
    const profile = fireRetirementProfile({ context: ctx(), levels: null });

    expect(profile.signals).toEqual([
      {
        kind: "target_age_is_ordinary",
        ordinaryRetirementAge: 65,
        targetRetirementAge: 67,
      },
    ]);
    expect(profile.state).toBe("offer");
  });

  it("la edad ordinaria es un dato del usuario: subiéndola, la misma edad objetivo deja de ser señal", () => {
    const profile = fireRetirementProfile({
      context: ctx({ ordinaryRetirementAge: 70 }),
      levels: null,
    });

    expect(profile.signals).toEqual([]);
    expect(profile.ordinaryRetirementAge).toBe(70);
    expect(profile.state).toBe("fire");
  });

  it("sin edad objetivo declarada no hay señal: el 65 del motor es un respaldo, no una elección", () => {
    const profile = fireRetirementProfile({
      context: ctx({}, NO_TARGET_AGE_CONFIG),
      levels: null,
    });

    expect(profile.signals).toEqual([]);
    expect(profile.state).toBe("fire");
  });

  it("sin ahorro declarado, un Regular inalcanzable no es señal: la cifra no existe todavía", () => {
    const profile = fireRetirementProfile({
      context: ctx({}, NO_SAVINGS_CONFIG),
      levels: rail({ kind: "unreachable" }),
    });

    expect(profile.signals).toEqual([]);
  });

  it("una edad objetivo temprana no es señal", () => {
    const profile = fireRetirementProfile({
      context: ctx({ targetRetirementAge: 50 }),
      levels: null,
    });

    expect(profile.signals).toEqual([]);
    expect(profile.state).toBe("fire");
  });

  it("un Regular inalcanzable con el ahorro declarado es señal por sí solo", () => {
    const profile = fireRetirementProfile({
      context: ctx({ targetRetirementAge: 50 }),
      levels: rail({ kind: "unreachable" }),
    });

    expect(profile.signals).toEqual([{ kind: "regular_unreachable" }]);
    expect(profile.state).toBe("offer");
  });

  it("un Regular con fecha o ya alcanzado no es señal", () => {
    expect(
      fireRetirementProfile({
        context: ctx({ targetRetirementAge: 50 }),
        levels: rail({ kind: "eta", years: 12 }),
      }).signals,
    ).toEqual([]);
    expect(
      fireRetirementProfile({
        context: ctx({ targetRetirementAge: 50 }),
        levels: rail({ kind: "reached" }),
      }).signals,
    ).toEqual([]);
  });

  it("las dos señales pueden convivir, y el orden es estable", () => {
    const profile = fireRetirementProfile({
      context: ctx(),
      levels: rail({ kind: "unreachable" }),
    });

    expect(profile.signals.map((signal) => signal.kind)).toEqual([
      "target_age_is_ordinary",
      "regular_unreachable",
    ]);
  });
});

describe("fireRetirementProfile — la declaración decide, la señal solo propone", () => {
  it("declarar «jubilación ordinaria» pone la pantalla en ese estado", () => {
    const profile = fireRetirementProfile({
      context: ctx({ retirementPlan: "ordinary" }),
      levels: null,
    });

    expect(profile.state).toBe("ordinary");
    expect(profile.declared).toBe("ordinary");
  });

  it("declarar «ordinaria» manda aunque no haya ninguna señal: nadie tiene que encajar en el patrón para pedirlo", () => {
    const profile = fireRetirementProfile({
      context: ctx({ retirementPlan: "ordinary", targetRetirementAge: 45 }),
      levels: rail({ kind: "eta", years: 4 }),
    });

    expect(profile.signals).toEqual([]);
    expect(profile.state).toBe("ordinary");
  });

  it("declarar FIRE calla el ofrecimiento: un «no» no se vuelve a preguntar", () => {
    const profile = fireRetirementProfile({
      context: ctx({ retirementPlan: "early" }),
      levels: rail({ kind: "unreachable" }),
    });

    expect(profile.signals.length).toBeGreaterThan(0);
    expect(profile.declared).toBe("early");
    expect(profile.state).toBe("fire");
  });

  it("sin declaración y sin señales no hay nada que ofrecer", () => {
    const profile = fireRetirementProfile({
      context: ctx({ targetRetirementAge: 45 }),
      levels: rail({ kind: "eta", years: 4 }),
    });

    expect(profile.declared).toBeNull();
    expect(profile.state).toBe("fire");
  });
});
