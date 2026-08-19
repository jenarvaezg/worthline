import { describe, expect, test } from "vitest";
import {
  type FireAssumptionDraft,
  fireAssumptionOverrides,
  isFireAssumptionDraftDirty,
} from "./fire-assumption-draft";

const saved: FireAssumptionDraft = {
  monthlySavingsCapacity: "1000",
  monthlySpending: "2000",
  safeWithdrawalRate: "3.5",
  targetRetirementAge: "67",
};

describe("el borrador de supuestos que la isla previsualiza (#1450)", () => {
  test("traduce los cuatro campos a las unidades del motor", () => {
    expect(fireAssumptionOverrides(saved)).toEqual({
      monthlySavingsCapacityMinor: 100_000,
      monthlySpendingMinor: 200_000,
      safeWithdrawalRate: 0.035,
      targetRetirementAge: 67,
    });
  });

  test("acepta la coma decimal española", () => {
    expect(
      fireAssumptionOverrides({ ...saved, safeWithdrawalRate: "3,5" }).safeWithdrawalRate,
    ).toBeCloseTo(0.035);
  });

  test("un campo a medio escribir no borra lo guardado", () => {
    // Vaciar el gasto para reescribirlo no puede tirar el número FIRE a cero
    // mientras se teclea: el override desaparece y el motor sigue con lo suyo.
    const overrides = fireAssumptionOverrides({ ...saved, monthlySpending: "" });

    expect(overrides.monthlySpendingMinor).toBeUndefined();
    expect(overrides.safeWithdrawalRate).toBeCloseTo(0.035);
  });

  test("ni un cero que dividiría por cero, ni un gasto nulo", () => {
    const overrides = fireAssumptionOverrides({
      ...saved,
      monthlySpending: "0",
      safeWithdrawalRate: "0",
    });

    expect(overrides.monthlySpendingMinor).toBeUndefined();
    expect(overrides.safeWithdrawalRate).toBeUndefined();
  });

  test("pero un ahorro de cero sí se previsualiza: es una declaración", () => {
    expect(
      fireAssumptionOverrides({ ...saved, monthlySavingsCapacity: "0" })
        .monthlySavingsCapacityMinor,
    ).toBe(0);
  });

  test("sabe si hay algo sin guardar", () => {
    expect(isFireAssumptionDraftDirty(saved, saved)).toBe(false);
    expect(isFireAssumptionDraftDirty({ ...saved, monthlySpending: "2500" }, saved)).toBe(
      true,
    );
  });
});
