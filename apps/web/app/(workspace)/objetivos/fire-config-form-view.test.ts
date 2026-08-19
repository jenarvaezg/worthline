import type { FireAgeSource, FireScopeConfig } from "@worthline/domain";
import { describe, expect, test } from "vitest";
import {
  fireConfigFieldValues,
  fireCurrentAgeReadout,
  fireReturnReadout,
  fireSavingsPlaceholder,
  fireSavingsSuggestionLine,
} from "./fire-config-form-view";
import { fireAgeProvenance } from "./fire-provenance";

const config: FireScopeConfig = {
  excludedAssetIds: [],
  monthlySpendingMinor: 200_000,
  safeWithdrawalRate: 0.035,
  targetRetirementAge: 63,
};

const ageSource: FireAgeSource = {
  age: 63,
  birthYear: 1963,
  memberId: "member_jorge",
  memberName: "Jorge",
};

describe("los valores que el formulario mudado precarga (#1450)", () => {
  test("un scope configurado precarga cada campo con lo guardado", () => {
    const values = fireConfigFieldValues({
      ...config,
      baristaMonthlyIncomeMinor: 50_000,
      expectedRealReturn: 0.042,
      fatMultiplier: 1.4,
      leanMultiplier: 0.8,
      monthlySavingsCapacityMinor: 150_000,
      tierRealReturns: { cash: 0, market: 0.05 },
    });

    expect(values.monthlySpending).toBe("2000");
    expect(values.safeWithdrawalRate).toBe("3.5");
    expect(values.targetRetirementAge).toBe("63");
    expect(values.monthlySavingsCapacity).toBe("1500");
    expect(values.expectedRealReturn).toBe("4.2");
    expect(values.leanMultiplier).toBe("0.8");
    expect(values.fatMultiplier).toBe("1.4");
    expect(values.baristaIncome).toBe("500");
    expect(values.tierReturns.cash).toBe("0");
    expect(values.tierReturns.market).toBe("5");
    expect(values.tierReturns.illiquid).toBeUndefined();
  });

  test("sin config los dos campos con defecto del motor los declaran, el resto van vacíos", () => {
    // Un scope nuevo no puede enseñar campos en blanco donde el parser aplicará
    // 4 % y 65: el formulario mentiría sobre con qué se va a calcular.
    const values = fireConfigFieldValues(undefined);

    expect(values.safeWithdrawalRate).toBe("4");
    expect(values.targetRetirementAge).toBe("65");
    expect(values.monthlySpending).toBeUndefined();
    expect(values.monthlySavingsCapacity).toBeUndefined();
    expect(values.expectedRealReturn).toBeUndefined();
  });

  test("un ahorro de cero se precarga como cero, no como vacío", () => {
    // «No ahorro ahora mismo» es una declaración válida (#1416): si el campo se
    // pintara vacío, guardar volvería a dejar la capacidad sin valor.
    const values = fireConfigFieldValues({ ...config, monthlySavingsCapacityMinor: 0 });

    expect(values.monthlySavingsCapacity).toBe("0");
  });
});

describe("la edad actual se lee, no se teclea (#1415 en la pantalla nueva)", () => {
  test("derivada dice de qué año de nacimiento sale", () => {
    const readout = fireCurrentAgeReadout({ ageSource, config });

    expect(readout.value).toBe("63 años");
    expect(readout.gloss).toContain("1963");
    expect(readout.gloss).toContain("no caduca");
  });

  test("una edad heredada de la config vieja se declara congelada", () => {
    const readout = fireCurrentAgeReadout({
      ageSource: null,
      config: { ...config, currentAge: 48 },
    });

    expect(readout.value).toBe("48 años");
    expect(readout.gloss).toContain("no se actualiza sola");
  });

  test("sin fecha de nacimiento dice qué se pierde y dónde se arregla", () => {
    const readout = fireCurrentAgeReadout({ ageSource: null, config });

    expect(readout.value).toBe("—");
    expect(readout.gloss).toContain("Sin fecha de nacimiento no hay edad actual");
    expect(readout.gloss).toContain("Miembros");
  });
});

describe("el retorno real dice de dónde sale", () => {
  test("con override manual se declara fijado a mano", () => {
    const readout = fireReturnReadout({
      config: { ...config, expectedRealReturn: 0.042 },
      realReturnUsed: 0.042,
    });

    expect(readout.value).toBe("4,2 % (fijado a mano)");
    expect(readout.gloss).toContain("ponderación");
  });

  test("sin override es la ponderación de la mezcla, y cita la tasa en uso", () => {
    const readout = fireReturnReadout({ config, realReturnUsed: 0.035 });

    expect(readout.value).toBe("3,5 % (ponderado de tu mezcla)");
    expect(readout.gloss).toContain("inflación");
  });

  test("sin cifra calculada no se inventa una", () => {
    const readout = fireReturnReadout({ config: undefined, realReturnUsed: null });

    expect(readout.value).toBe("—");
  });
});

describe("la sugerencia de ahorro por histórico", () => {
  test("con base en operaciones ofrece la cifra como pista", () => {
    const line = fireSavingsSuggestionLine(
      { amountMinor: 123_400, basis: "operations", monthsCovered: 12 },
      (amountMinor) => `${amountMinor / 100} €`,
    );

    expect(line).toContain("1234 €");
  });

  test("sin datos suficientes no se ofrece nada", () => {
    expect(
      fireSavingsSuggestionLine(
        { amountMinor: 0, basis: "insufficient_data", monthsCovered: 0 },
        (amountMinor) => `${amountMinor / 100} €`,
      ),
    ).toBeNull();
  });
});

describe("la procedencia de la edad es un discriminante, no un booleano", () => {
  test("distingue derivada, congelada y ausente", () => {
    // Los dos módulos que la redactan (el formulario y el pliegue de #1426) tienen
    // que estar de acuerdo en el estado aunque usen palabras distintas.
    expect(fireAgeProvenance(ageSource, config)).toEqual({
      age: 63,
      birthYear: 1963,
      kind: "derived",
    });
    expect(fireAgeProvenance(null, { ...config, currentAge: 48 })).toEqual({
      age: 48,
      kind: "frozen",
    });
    expect(fireAgeProvenance(null, config)).toEqual({ kind: "absent" });
    expect(fireAgeProvenance(null, undefined)).toEqual({ kind: "absent" });
  });
});

describe("la marca de agua del ahorro", () => {
  test("es la cifra medida cuando el libro la tiene", () => {
    expect(
      fireSavingsPlaceholder({
        amountMinor: 123_400,
        basis: "operations",
        monthsCovered: 12,
      }),
    ).toBe("1234");
  });

  test("y cero cuando no: una capacidad sin declarar se proyecta como cero", () => {
    expect(
      fireSavingsPlaceholder({
        amountMinor: 0,
        basis: "insufficient_data",
        monthsCovered: 0,
      }),
    ).toBe("0");
  });
});

describe("fireConfigFieldValues — la declaración sobre el inmovilizado (#1460)", () => {
  test("sin config la casilla nace marcada: el defecto es que cuente", () => {
    expect(fireConfigFieldValues(null).immobilizedCounts).toBe(true);
  });

  test("una config antigua, sin el campo, también la deja marcada", () => {
    expect(
      fireConfigFieldValues({ monthlySpendingMinor: 200_000, safeWithdrawalRate: 0.04 })
        .immobilizedCounts,
    ).toBe(true);
  });

  test("una declaración de «no cuenta» se relee desmarcada", () => {
    expect(
      fireConfigFieldValues({
        immobilizedCountsAsFireCapital: false,
        monthlySpendingMinor: 200_000,
        safeWithdrawalRate: 0.04,
      }).immobilizedCounts,
    ).toBe(false);
  });
});
