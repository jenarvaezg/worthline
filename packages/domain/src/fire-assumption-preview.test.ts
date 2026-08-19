import { describe, expect, test } from "vitest";
import { calculateFireForScope, type FireScopeConfig } from "./fire";
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

function baseline(overrides: Partial<FireScopeConfig> = {}) {
  return calculateFireForScope(
    {
      currentAge: 62,
      excludedAssetIds: [],
      monthlySpendingMinor: 2_000_00,
      monthlySavingsCapacityMinor: 1_000_00,
      safeWithdrawalRate: 0.035,
      targetRetirementAge: 67,
      ...overrides,
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
    const preview = previewFireWithAssumptions(base, {
      safeWithdrawalRate: 0.05,
    });

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
    expect(withoutAge.fireAgeIfContributionsStop).toBeUndefined();
  });
});

describe("el inmovilizado previsualiza como los demás supuestos (#1473)", () => {
  /** El otro lado del par: la MISMA aritmética con la declaración invertida. */
  function excludingImmobilized() {
    return baseline({ immobilizedCountsAsFireCapital: false });
  }

  test("alternar el check mueve el capital Y la tasa, sin recalcular nada en el cliente", () => {
    const counting = baseline();
    const preview = previewFireWithAssumptions(
      counting,
      { immobilizedCountsAsFireCapital: false },
      excludingImmobilized(),
    );

    // Fuera el piso: queda el fondo solo, y la tasa sube porque el tramo housing
    // era el que la arrastraba hacia abajo (la trampa central de #1460).
    expect(preview.eligibleAssets.amountMinor).toBe(100_000_00);
    expect(preview.context.realReturnUsed).toBeGreaterThan(
      counting.context.realReturnUsed,
    );
    expect(preview.percentFunded).toBeLessThan(counting.percentFunded);
  });

  test("el lado elegido trae SU split, SU mezcla y SU declaración, no las del baseline", () => {
    const other = excludingImmobilized();
    const preview = previewFireWithAssumptions(
      baseline(),
      { immobilizedCountsAsFireCapital: false },
      other,
    );

    expect(preview.capitalSplit).toBe(other.capitalSplit);
    expect(preview.returnMix).toBe(other.returnMix);
    expect(preview.rentReturns).toBe(other.rentReturns);
    expect(preview.context.config.immobilizedCountsAsFireCapital).toBe(false);
  });

  test("previsualizar y guardar dan lo MISMO: el contrafactual sale del mismo motor", () => {
    // La guarda del issue: alternar en vivo tiene que dejar la pantalla exactamente
    // donde la dejará el guardado, o el preview sería una segunda aritmética.
    const preview = previewFireWithAssumptions(
      baseline(),
      { immobilizedCountsAsFireCapital: false },
      excludingImmobilized(),
    );
    const saved = excludingImmobilized();

    expect(preview.fireNumber).toEqual(saved.fireNumber);
    expect(preview.percentFunded).toBe(saved.percentFunded);
    expect(preview.context.realReturnUsed).toBe(saved.context.realReturnUsed);
    expect(preview.coastFireRequired).toEqual(saved.coastFireRequired);
    expect(preview.fireAgeIfContributionsStop).toBe(saved.fireAgeIfContributionsStop);
  });

  test("y vuelve al lado guardado al re-marcarlo", () => {
    const counting = baseline();
    const back = previewFireWithAssumptions(
      counting,
      { immobilizedCountsAsFireCapital: true },
      excludingImmobilized(),
    );

    expect(back.eligibleAssets).toEqual(counting.eligibleAssets);
    expect(back.context.realReturnUsed).toBe(counting.context.realReturnUsed);
    expect(back.capitalSplit).toBe(counting.capitalSplit);
  });

  test("con la tasa fijada a mano, alternar mueve el capital pero NO la tasa", () => {
    const manual = { expectedRealReturn: 0.04 };
    const preview = previewFireWithAssumptions(
      baseline(manual),
      { immobilizedCountsAsFireCapital: false },
      baseline({ ...manual, immobilizedCountsAsFireCapital: false }),
    );

    expect(preview.context.realReturnUsed).toBe(0.04);
    expect(preview.eligibleAssets.amountMinor).toBe(100_000_00);
  });

  test("sin contrafactual no se inventa uno: se conserva el lado del baseline", () => {
    // Un llamador que no precalculó el par no puede recibir cifras a medias — ni el
    // capital del baseline bajo una declaración que dice otra cosa.
    const counting = baseline();
    const preview = previewFireWithAssumptions(counting, {
      immobilizedCountsAsFireCapital: false,
    });

    expect(preview.eligibleAssets).toEqual(counting.eligibleAssets);
    expect(preview.context.config.immobilizedCountsAsFireCapital).toBe(
      counting.context.config.immobilizedCountsAsFireCapital,
    );
  });
});
