import type { Liability, ManualAsset, Workspace } from "@worthline/domain";
import { calculateFireForScope, previewFireWithAssumptions } from "@worthline/domain";
import { describe, expect, test } from "vitest";
import {
  type FireAssumptionDraft,
  fireAssumptionOverrides,
  isFireAssumptionDraftDirty,
} from "./fire-assumption-draft";

const saved: FireAssumptionDraft = {
  countImmobilized: true,
  monthlySavingsCapacity: "1000",
  monthlySpending: "2000",
  safeWithdrawalRate: "3.5",
  targetRetirementAge: "67",
};

describe("el borrador de supuestos que la isla previsualiza (#1450)", () => {
  test("traduce los campos editables a las unidades del motor", () => {
    expect(fireAssumptionOverrides(saved)).toEqual({
      immobilizedCountsAsFireCapital: true,
      monthlySavingsCapacityMinor: 100_000,
      monthlySpendingMinor: 200_000,
      safeWithdrawalRate: 0.035,
      targetRetirementAge: 67,
    });
  });

  test("la declaración del inmovilizado viaja siempre: no hay medio marcar (#1473)", () => {
    // No es texto a medio teclear, es un booleano: el override existe en los dos
    // estados, y desmarcado tiene que decir «no» en voz alta y no callar.
    expect(
      fireAssumptionOverrides({ ...saved, countImmobilized: false })
        .immobilizedCountsAsFireCapital,
    ).toBe(false);
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

  test("sabe si hay algo sin guardar, el check incluido", () => {
    expect(isFireAssumptionDraftDirty(saved, saved)).toBe(false);
    expect(isFireAssumptionDraftDirty({ ...saved, monthlySpending: "2500" }, saved)).toBe(
      true,
    );
    // Sin esto, alternar el check previsualizaría sin declarar que no está guardado
    // (#1473): unas cifras nuevas se leerían como cifras firmes.
    expect(isFireAssumptionDraftDirty({ ...saved, countImmobilized: false }, saved)).toBe(
      true,
    );
  });
});

/**
 * El fixture (fondo vendible + piso inmovilizado) repite el de
 * `fire-assumption-preview.test.ts` a propósito: lo que aquí se prueba no es el motor
 * sino la CADENA de esta pantalla, y el dominio no exporta fixtures de test — un barril
 * con datos de prueba dentro sería peor que veinte líneas repetidas.
 */
describe("el cableado del check llega al motor (#1473)", () => {
  const workspace: Workspace = {
    baseCurrency: "EUR",
    groups: [],
    members: [{ id: "member_jorge", name: "Jorge", birthYear: 1963 }],
    mode: "individual",
  };
  const assets: ManualAsset[] = [
    {
      currency: "EUR",
      currentValue: { amountMinor: 100_000_00, currency: "EUR" },
      id: "asset_fondo",
      isPrimaryResidence: false,
      liquidityTier: "market",
      name: "Fondo indexado",
      ownership: [{ memberId: "member_jorge", shareBps: 10_000 }],
      type: "investment",
    },
    {
      currency: "EUR",
      currentValue: { amountMinor: 200_000_00, currency: "EUR" },
      id: "asset_piso",
      isPrimaryResidence: false,
      liquidityTier: "housing",
      name: "Piso alquilado",
      ownership: [{ memberId: "member_jorge", shareBps: 10_000 }],
      type: "real_estate",
    },
  ];
  const liabilities: Liability[] = [];

  const fireFor = (countsImmobilized: boolean) =>
    calculateFireForScope(
      {
        currentAge: 62,
        immobilizedCountsAsFireCapital: countsImmobilized,
        monthlySavingsCapacityMinor: 100_000,
        monthlySpendingMinor: 200_000,
        safeWithdrawalRate: 0.035,
        targetRetirementAge: 67,
      },
      assets,
      liabilities,
      workspace,
      "household",
    );

  test("desmarcarlo mueve el capital Y la tasa por la misma cadena que usa la isla", () => {
    // La cadena entera —borrador → overrides → motor— y no cada mitad por su lado:
    // el nombre del campo es lo que las une, y un escritor que no coincide con su
    // lector es un check que se alterna y no pasa nada.
    const preview = previewFireWithAssumptions(
      fireFor(true),
      fireAssumptionOverrides({ ...saved, countImmobilized: false }),
      fireFor(false),
    );

    expect(preview.eligibleAssets.amountMinor).toBe(100_000_00);
    expect(preview.capitalSplit.countsImmobilized).toBe(false);
    expect(preview.context.realReturnUsed).toBeGreaterThan(
      fireFor(true).context.realReturnUsed,
    );
  });
});
