import type { FireScopeConfig, ScopeFireResult } from "@worthline/domain";
import { describe, expect, test } from "vitest";
import {
  coastAbsenceNote,
  coastArrivalMetric,
  coastFormulaLine,
  coastProgressPercent,
  contributionsStopMetric,
  etaYearsLabel,
  fireFundedView,
} from "./fire-funding-view";

const formatMoney = (amountMinor: number) =>
  `${new Intl.NumberFormat("es-ES", { maximumFractionDigits: 0 }).format(
    Math.round(amountMinor / 100),
  )} €`;

/** Only the fields the funding view reads; the rest of the result is irrelevant here. */
function resultOf(eligibleMinor: number, fireNumberMinor: number): ScopeFireResult {
  return {
    eligibleAssets: { amountMinor: eligibleMinor, currency: "EUR" },
    fireNumber: { amountMinor: fireNumberMinor, currency: "EUR" },
    percentFunded: (eligibleMinor / fireNumberMinor) * 100,
  } as ScopeFireResult;
}

describe("fireFundedView (#1426)", () => {
  test("carries the fraction the percentage came from", () => {
    const view = fireFundedView({
      formatMoney,
      result: resultOf(469_671_00, 685_714_29),
    });

    expect(view).toEqual({
      fraction: "469.671 € de 685.714 €",
      percent: "68,5 %",
    });
  });
});

describe("coastAbsenceNote (#1425)", () => {
  const config: FireScopeConfig = {
    currentAge: 63,
    monthlySpendingMinor: 200_000,
    safeWithdrawalRate: 0.035,
    targetRetirementAge: 67,
  };

  test("dice por qué no hay Coast cuando la rentabilidad no compone", () => {
    expect(
      coastAbsenceNote({
        config,
        realReturnUsed: 0,
        result: {} as ScopeFireResult,
      }),
    ).toContain("con una rentabilidad esperada del 0,0 % el capital no crece solo");
  });

  test("y por qué no lo hay cuando la edad objetivo ya llegó — otra razón, otro arreglo", () => {
    expect(
      coastAbsenceNote({
        config: { ...config, currentAge: 70 },
        realReturnUsed: 0.04,
        result: {} as ScopeFireResult,
      }),
    ).toContain("tu edad objetivo ya ha llegado");
  });

  test("calla cuando el bloque de Coast sí se pinta, y cuando no hay ni edad", () => {
    expect(
      coastAbsenceNote({
        config,
        realReturnUsed: 0.04,
        result: {
          coastFireRequired: { amountMinor: 597_477_00, currency: "EUR" },
        } as ScopeFireResult,
      }),
    ).toBeNull();
    const { currentAge: _derived, ...ageless } = config;
    expect(
      coastAbsenceNote({
        config: ageless,
        realReturnUsed: 0,
        result: {} as ScopeFireResult,
      }),
    ).toBeNull();
  });
});

describe("coastProgressPercent (#1426)", () => {
  test("measures the reader's progress toward Coast, not the tick's position", () => {
    // 469.671 € against a 577.000 € coast requirement — «llevo el ~81 % de Coast».
    expect(coastProgressPercent(469_671_00, 577_000_00)).toBeCloseTo(81.4, 1);
  });

  test("can pass 100 % once Coast is behind you", () => {
    expect(coastProgressPercent(600_000_00, 500_000_00)).toBeCloseTo(120, 10);
  });

  test("is null with no coast requirement to measure against", () => {
    expect(coastProgressPercent(100_000_00, null)).toBeNull();
    expect(coastProgressPercent(100_000_00, undefined)).toBeNull();
    expect(coastProgressPercent(100_000_00, 0)).toBeNull();
  });
});

describe("coastFormulaLine (#1426)", () => {
  const config: FireScopeConfig = {
    currentAge: 63,
    monthlySpendingMinor: 200_000,
    safeWithdrawalRate: 0.035,
    targetRetirementAge: 67,
  };

  /** Only the fields the coast line reads. */
  function coastResult(rate: number): ScopeFireResult {
    return {
      coastFireRequired: { amountMinor: 597_477_00, currency: "EUR" },
      context: { realReturnUsed: rate },
      fireNumber: { amountMinor: 685_714_29, currency: "EUR" },
    } as ScopeFireResult;
  }

  test("closes the chain: the requirement says what it was discounted from, and how", () => {
    expect(coastFormulaLine({ config, formatMoney, result: coastResult(0.035) })).toBe(
      "tu número FIRE descontado 4 años al 3,5 %: 685.714 € → 597.477 €",
    );
  });

  test("says one year in the singular", () => {
    expect(
      coastFormulaLine({
        config: { ...config, targetRetirementAge: 64 },
        formatMoney,
        result: coastResult(0.035),
      }),
    ).toContain("descontado 1 año al");
  });

  test("is null when there is no coast requirement or no age to count from", () => {
    expect(
      coastFormulaLine({ config, formatMoney, result: {} as ScopeFireResult }),
    ).toBeNull();
    const { currentAge: _derived, ...ageless } = config;
    expect(
      coastFormulaLine({ config: ageless, formatMoney, result: coastResult(0.035) }),
    ).toBeNull();
  });
});

describe("etaYearsLabel (#1425)", () => {
  test("es el mismo «cuándo» para el rail de niveles y para la llegada a Coast", () => {
    expect(etaYearsLabel(4.6)).toBe("en ~4,6 años");
    // Sin decimal forzado: «en ~5,0 años» finge una precisión que la interpolación
    // anual no tiene.
    expect(etaYearsLabel(5)).toBe("en ~5 años");
    expect(etaYearsLabel(0.4)).toBe("este año");
    expect(etaYearsLabel(0)).toBe("este año");
  });
});

describe("coastArrivalMetric (#1425)", () => {
  test("dates the arrival at Coast with the premise the figure rests on", () => {
    expect(coastArrivalMetric({ age: 68, kind: "eta", years: 4.6 }, 150_000)).toEqual({
      gloss: "con tus aportaciones, en ~4,6 años",
      label: "Llegas a Coast",
      value: "a los 68",
    });
  });

  test("says «este año» instead of «en ~0 años» when the crossing is imminent", () => {
    expect(coastArrivalMetric({ age: 63, kind: "eta", years: 0.4 }, 150_000)?.gloss).toBe(
      "con tus aportaciones, este año",
    );
  });

  test("no atribuye la fecha a aportaciones que valen cero", () => {
    // El caso que hace que la edad de Coast se acerque a la de FIRE: sin ahorro, la
    // llegada la trae el interés compuesto y la glosa no puede decir otra cosa.
    expect(coastArrivalMetric({ age: 78, kind: "eta", years: 39.2 }, 0)?.gloss).toBe(
      "sin ahorro declarado, solo con el interés compuesto, en ~39,2 años",
    );
  });

  test("is a seal, not an age, once Coast is behind you", () => {
    expect(coastArrivalMetric({ kind: "reached" }, 150_000)).toEqual({
      gloss: "tu capital ya crece solo hasta tu número FIRE",
      label: "Llegas a Coast",
      value: "alcanzado",
    });
  });

  test("admits it when the declared savings never cross the requirement", () => {
    expect(coastArrivalMetric({ kind: "unreachable" }, 150_000)).toEqual({
      gloss: "con tu ahorro declarado no lo cruzas dentro de la proyección",
      label: "Llegas a Coast",
      value: "—",
    });
  });

  test("is null when there is no Coast to arrive at", () => {
    expect(coastArrivalMetric(null, 150_000)).toBeNull();
  });
});

describe("contributionsStopMetric (#1425)", () => {
  test("names its premise instead of borrowing the word Coast", () => {
    // La antigua «Edad Coast»: la edad a la que se llega al número FIRE COMPLETO
    // dejando de aportar hoy — otra pregunta, y por eso otro nombre.
    expect(
      contributionsStopMetric({
        formatMoney,
        result: {
          context: { realReturnUsed: 0.035 },
          eligibleAssets: { amountMinor: 469_671_00, currency: "EUR" },
          fireAgeIfContributionsStop: 72.99,
        } as ScopeFireResult,
      }),
    ).toEqual({
      // Con su aritmética, como el resto de la cadena (ADR 0077).
      gloss: "469.671 € creciendo al 3,5 %, sin aportar un euro más",
      label: "Si dejas de aportar hoy",
      value: "FIRE a los 73",
    });
  });

  test("is null when the figure could not be derived", () => {
    expect(
      contributionsStopMetric({ formatMoney, result: {} as ScopeFireResult }),
    ).toBeNull();
  });
});
