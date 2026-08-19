import { describe, expect, test } from "vitest";
import { calculateFireForScope } from "./fire";
import { previewFireWithAssumptions } from "./fire-assumption-preview";
import type { Liability, ManualAsset, Workspace } from "./index";

const workspace: Workspace = {
  baseCurrency: "EUR",
  groups: [],
  members: [{ id: "member_jorge", name: "Jorge", birthYear: 1963 }],
  mode: "individual",
};

const assets: ManualAsset[] = [
  {
    id: "asset_fondo",
    name: "Fondo indexado",
    type: "investment",
    currency: "EUR",
    currentValue: { amountMinor: 100_000_00, currency: "EUR" },
    liquidityTier: "market",
    ownership: [{ memberId: "member_jorge", shareBps: 10_000 }],
    isPrimaryResidence: false,
  },
  {
    id: "asset_piso",
    name: "Piso alquilado",
    type: "real_estate",
    currency: "EUR",
    currentValue: { amountMinor: 200_000_00, currency: "EUR" },
    liquidityTier: "housing",
    ownership: [{ memberId: "member_jorge", shareBps: 10_000 }],
    isPrimaryResidence: false,
  },
];

const liabilities: Liability[] = [];

function baseline() {
  return calculateFireForScope(
    {
      currentAge: 62,
      excludedAssetIds: [],
      monthlySpendingMinor: 2_000_00,
      monthlySavingsCapacityMinor: 1_000_00,
      safeWithdrawalRate: 0.035,
      targetRetirementAge: 67,
    },
    assets,
    liabilities,
    workspace,
    "household",
  );
}

describe("previsualizar unos supuestos tecleados (#1450)", () => {
  test("el número FIRE y el % financiado se mueven con lo tecleado", () => {
    const preview = previewFireWithAssumptions(baseline(), {
      monthlySpendingMinor: 3_000_00,
    });

    // 3.000 × 12 ÷ 3,5 % — la misma división que la pantalla imprime.
    expect(preview.fireNumber.amountMinor).toBe(Math.round((3_000_00 * 12) / 0.035));
    expect(preview.percentFunded).toBeLessThan(baseline().percentFunded);
    expect(preview.context.config.monthlySpendingMinor).toBe(3_000_00);
  });

  test("el capital, la mezcla y el split NO se recalculan: los supuestos no cambian lo que tienes", () => {
    const base = baseline();
    const preview = previewFireWithAssumptions(base, { safeWithdrawalRate: 0.05 });

    expect(preview.eligibleAssets).toEqual(base.eligibleAssets);
    expect(preview.capitalSplit).toBe(base.capitalSplit);
    expect(preview.returnMix).toBe(base.returnMix);
    expect(preview.excludedAssets).toBe(base.excludedAssets);
    expect(preview.context.realReturnUsed).toBe(base.context.realReturnUsed);
  });

  test("un campo sin tocar conserva lo guardado", () => {
    const base = baseline();
    const preview = previewFireWithAssumptions(base, {});

    expect(preview.fireNumber).toEqual(base.fireNumber);
    expect(preview.context.config).toEqual(base.context.config);
  });

  test("el Coast se recalcula con la edad objetivo tecleada", () => {
    const base = baseline();
    const later = previewFireWithAssumptions(base, { targetRetirementAge: 75 });

    // Más años de compuesto por delante ⇒ hace falta menos capital hoy.
    expect(later.coastFireRequired!.amountMinor).toBeLessThan(
      base.coastFireRequired!.amountMinor,
    );
  });

  test("y desaparece si el recálculo se queda sin él, en vez de sobrevivir bajo cifras nuevas", () => {
    // Sin edad actual no hay tramo de compuesto que medir: el Coast del baseline no
    // puede quedarse en pantalla junto a un número FIRE que ya no es el suyo.
    const base = baseline();
    const { currentAge: _dropped, ...configWithoutAge } = base.context.config;
    const withoutAge = previewFireWithAssumptions(
      { ...base, context: { ...base.context, config: configWithoutAge } },
      { monthlySpendingMinor: 4_000_00 },
    );

    expect(base.coastFireRequired).toBeDefined();
    expect(withoutAge.coastFireRequired).toBeUndefined();
    expect(withoutAge.coastFireAge).toBeUndefined();
  });
});
