/**
 * «El inmovilizado cuenta como capital FIRE» es una declaración del usuario (#1460,
 * ADR 0078).
 *
 * Medido con la cartera del usuario real: con el piso dentro, FIRE a los 49 y 17,9 %
 * financiado; solo con lo vendible, a los 55 y 4,6 %. Esta suite vigila las tres
 * cosas que hacen que esa segunda lectura sea honesta y no un pesimismo inventado:
 *
 * 1. Por defecto **nada cambia**: una config guardada antes de que el campo existiera
 *    mide exactamente lo que medía.
 * 2. Al desmarcarlo, el capital baja al lado vendible **y la tasa sube**, porque el
 *    tramo que la arrastraba hacia abajo era justo el ladrillo. Olvidar la segunda
 *    mitad daría un resultado más pesimista de lo declarado.
 * 3. Lo que sale del cálculo se **dice**: la fila del inmovilizado sigue existiendo y
 *    un alquiler declarado que ya no alimenta la tasa deja de anunciarse como
 *    aplicado sin quedarse callado.
 */

import { describe, expect, it } from "vitest";
import { calculateFireForScope } from "./fire";
import { TIER_REAL_RETURN_DEFAULTS } from "./fire-return";
import type { Liability, ManualAsset, PayoutSchedule, Workspace } from "./index";

const workspace: Workspace = {
  baseCurrency: "EUR",
  mode: "household",
  members: [{ id: "alice", name: "Alice" }],
  groups: [],
};

function makeAsset(
  id: string,
  amountMinor: number,
  liquidityTier: ManualAsset["liquidityTier"] = "market",
): ManualAsset {
  return {
    id,
    name: id,
    type: "manual",
    currency: "EUR",
    currentValue: { amountMinor, currency: "EUR" },
    liquidityTier,
    ownership: [{ memberId: "alice", shareBps: 10_000 }],
    isPrimaryResidence: false,
  };
}

function flat(id: string, valueMinor: number): ManualAsset {
  return { ...makeAsset(id, valueMinor, "illiquid"), instrument: "property" };
}

const BASE_CONFIG = {
  monthlySpendingMinor: 200_000,
  safeWithdrawalRate: 0.04,
} as const;

// La forma del usuario real, redondeada: 370.000 € de ladrillo alquilado junto a
// 168.000 € de mercado.
const brick = flat("piso", 37_000_000);
const market = makeAsset("fondo", 16_800_000, "market");

const fireFor = (
  config: Partial<typeof BASE_CONFIG> & Record<string, unknown> = {},
  assets: ManualAsset[] = [brick, market],
  liabilities: Liability[] = [],
  reservedForGoalsMinor = 0,
) =>
  calculateFireForScope(
    { ...BASE_CONFIG, ...config },
    assets,
    liabilities,
    workspace,
    "alice",
    reservedForGoalsMinor,
  );

describe("the default is the behaviour every stored config already had", () => {
  it("an absent declaration counts the brick, like before the field existed", () => {
    const before = fireFor();
    const declared = fireFor({ immobilizedCountsAsFireCapital: true });

    expect(before.eligibleAssets.amountMinor).toBe(53_800_000);
    expect(declared.eligibleAssets.amountMinor).toBe(before.eligibleAssets.amountMinor);
    expect(declared.context.effectiveRealReturn).toBeCloseTo(
      before.context.effectiveRealReturn,
      10,
    );
    expect(before.capitalSplit.countsImmobilized).toBe(true);
    // La cifra medida ES la suma de las dos filas impresas debajo.
    expect(before.capitalSplit.drawableMinor).toBe(
      before.capitalSplit.sellable.amountMinor +
        before.capitalSplit.immobilized.amountMinor,
    );
  });
});

describe("declaring the brick out moves the capital AND the rate", () => {
  it("the eligible pool is the sellable side alone", () => {
    const result = fireFor({ immobilizedCountsAsFireCapital: false });

    expect(result.eligibleAssets.amountMinor).toBe(16_800_000);
    expect(result.capitalSplit.drawableMinor).toBe(16_800_000);
    expect(result.context.eligibleMinor).toBe(16_800_000);
    // 168.000 € sobre un número FIRE de 600.000 €.
    expect(result.percentFunded).toBeCloseTo(28, 10);
  });

  it("the rate is re-weighted with what is left, not kept at the brick-dragged one", () => {
    const counting = fireFor();
    const declaredOut = fireFor({ immobilizedCountsAsFireCapital: false });

    // Contando: 68,8 % de ladrillo al 3 % + 31,2 % de mercado al 5 %.
    expect(counting.context.effectiveRealReturn).toBeCloseTo(0.0362, 4);
    // Sin ladrillo queda solo mercado, así que la tasa sube al 5 % de su tramo.
    expect(declaredOut.context.effectiveRealReturn).toBeCloseTo(
      TIER_REAL_RETURN_DEFAULTS.market,
      10,
    );
    expect(declaredOut.context.realReturnUsed).toBeCloseTo(
      declaredOut.context.effectiveRealReturn,
      10,
    );
    expect(declaredOut.context.effectiveRealReturn).toBeGreaterThan(
      counting.context.effectiveRealReturn,
    );
  });

  it("the weighting table shows only the rungs the rate came from", () => {
    const { returnMix } = fireFor({ immobilizedCountsAsFireCapital: false });

    expect(returnMix.rows.map((row) => row.tier)).toEqual(["market"]);
    expect(returnMix.totalMinor).toBe(16_800_000);
    expect(returnMix.rows[0]!.weightFraction).toBeCloseTo(1, 10);
  });

  it("a manual rate is untouched: the declaration moves capital, not a typed figure", () => {
    const result = fireFor({
      expectedRealReturn: 0.07,
      immobilizedCountsAsFireCapital: false,
    });

    expect(result.context.realReturnUsed).toBeCloseTo(0.07, 10);
    expect(result.eligibleAssets.amountMinor).toBe(16_800_000);
  });

  it("Coast and its age are discounted over the pool the user declared", () => {
    const counting = fireFor({ currentAge: 40, targetRetirementAge: 65 });
    const declaredOut = fireFor({
      currentAge: 40,
      immobilizedCountsAsFireCapital: false,
      targetRetirementAge: 65,
    });

    // Menos capital y más tasa: el Coast requerido baja (se descuenta a un 5 % en vez
    // de a un 3,6 %) y la edad de llegada se aleja, que es la conversación del ticket.
    expect(declaredOut.coastFireRequired!.amountMinor).toBeLessThan(
      counting.coastFireRequired!.amountMinor,
    );
    expect(declaredOut.fireAgeIfContributionsStop!).toBeGreaterThan(
      counting.fireAgeIfContributionsStop!,
    );
  });
});

describe("what leaves the calculation is still on the page", () => {
  it("the immobilized row keeps its figure and says it is out", () => {
    const { capitalSplit } = fireFor({ immobilizedCountsAsFireCapital: false });

    expect(capitalSplit.countsImmobilized).toBe(false);
    expect(capitalSplit.immobilized.grossMinor).toBe(37_000_000);
    expect(capitalSplit.immobilized.amountMinor).toBe(37_000_000);
    expect(capitalSplit.drawableMinor).toBe(capitalSplit.sellable.amountMinor);
  });

  it("a declared rent on excluded brick is reported as withheld, never as applied", () => {
    const schedules: PayoutSchedule[] = [
      {
        amountMinor: 155_000,
        cadence: "monthly",
        endISO: null,
        exclusions: [],
        expensesMinor: 25_000,
        holdingId: "piso",
        id: "sched-piso",
        label: "Alquiler",
        startISO: "2024-01-01",
      },
    ];

    const counting = calculateFireForScope(
      BASE_CONFIG,
      [brick, market],
      [],
      workspace,
      "alice",
      0,
      { payoutSchedules: schedules, todayISO: "2026-08-18" },
    );
    const declaredOut = calculateFireForScope(
      { ...BASE_CONFIG, immobilizedCountsAsFireCapital: false },
      [brick, market],
      [],
      workspace,
      "alice",
      0,
      { payoutSchedules: schedules, todayISO: "2026-08-18" },
    );

    expect(counting.rentReturns.applied).toHaveLength(1);
    expect(declaredOut.rentReturns.applied).toHaveLength(0);
    expect(declaredOut.rentReturns.notices).toEqual([
      {
        assetId: "piso",
        assetName: "piso",
        grossRate: null,
        reason: "immobilized_not_counted",
      },
    ]);
    // Y su 4,2 % no se cuela en la tasa por la puerta de atrás.
    expect(declaredOut.context.effectiveRealReturn).toBeCloseTo(
      TIER_REAL_RETURN_DEFAULTS.market,
      10,
    );
  });
});

describe("debt and reservations respect the declared pool", () => {
  it("a mortgage nets inside the brick it secures, not against the market cash", () => {
    const mortgage: Liability = {
      id: "hipoteca",
      name: "Hipoteca",
      type: "mortgage",
      currency: "EUR",
      currentBalance: { amountMinor: 10_000_000, currency: "EUR" },
      ownership: [{ memberId: "alice", shareBps: 10_000 }],
      associatedAssetId: "piso",
    };

    const result = fireFor(
      { immobilizedCountsAsFireCapital: false },
      [brick, market],
      [mortgage],
    );

    expect(result.eligibleAssets.amountMinor).toBe(16_800_000);
    expect(result.capitalSplit.immobilized.amountMinor).toBe(27_000_000);
  });

  it("an underwater mortgage still spills onto what FIRE is measuring", () => {
    const mortgage: Liability = {
      id: "hipoteca",
      name: "Hipoteca",
      type: "mortgage",
      currency: "EUR",
      currentBalance: { amountMinor: 40_000_000, currency: "EUR" },
      ownership: [{ memberId: "alice", shareBps: 10_000 }],
      associatedAssetId: "piso",
    };

    const result = fireFor(
      { immobilizedCountsAsFireCapital: false },
      [brick, market],
      [mortgage],
    );

    // 3.000.000 que la garantía no cubre se comen parte de lo vendible: la deuda es
    // real aunque su ladrillo esté fuera del cálculo.
    expect(result.capitalSplit.sellable.absorbedDebtMinor).toBe(3_000_000);
    expect(result.eligibleAssets.amountMinor).toBe(13_800_000);
  });

  it("a reservation bigger than the sellable side cannot eat the excluded brick", () => {
    const result = fireFor(
      { immobilizedCountsAsFireCapital: false },
      [brick, market],
      [],
      20_000_000,
    );

    // Solo hay 168.000 € que FIRE mida, así que eso es todo lo que puede reservarse.
    expect(result.reservedForGoals!.amountMinor).toBe(16_800_000);
    expect(result.eligibleAssets.amountMinor).toBe(0);
    expect(result.capitalSplit.immobilized.reservedMinor).toBe(0);
    expect(result.capitalSplit.immobilized.amountMinor).toBe(37_000_000);
    // `eligibleGrossMinor` es bruto de RESERVA, no del ladrillo que quedó fuera.
    expect(result.context.eligibleGrossMinor).toBe(16_800_000);
  });
});
