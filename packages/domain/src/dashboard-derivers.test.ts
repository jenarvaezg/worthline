/**
 * The derivers `prepareDashboardState` composes (#1693).
 *
 * The state used to be one ~293-line body of mostly parallel branches, testable
 * only end to end: to check the delta you had to hand over a FIRE config, a ledger
 * and a price cache. Each family is now its own function with its own premise, and
 * these tests exercise those premises — plus the one invariant the split must keep:
 * the composition's fields ARE the derivers' outputs, so no surface can drift from
 * the figure the page shows.
 */
import { describe, expect, test } from "vitest";

import {
  deriveCoherences,
  deriveFireGlance,
  deriveFireSurfaces,
  deriveNetWorthSurfaces,
  type PrepareDashboardStateInput,
  prepareDashboardState,
  resolveFireScopeConfig,
} from "./dashboard";
import type {
  FireScopeConfig,
  InvestmentOperation,
  NetWorthSnapshot,
  NetWorthSummary,
} from "./index";
import {
  createManualAsset,
  createNetWorthSnapshot,
  createWorkspace,
  money,
} from "./index";

const workspace = createWorkspace({
  members: [{ id: "member_jose", name: "Jose" }],
  mode: "individual",
});
const fullOwnership = [{ memberId: "member_jose", shareBps: 10_000 }];
const scope = { id: "household", label: "Hogar", type: "household" as const };

const persistence = {
  checkKey: "bootstrap",
  checkedAt: "2026-06-01T12:00:00.000Z",
  checkValue: "2026-06-01T12:00:00.000Z",
  databasePath: "/tmp/test.sqlite",
  displayPath: "/tmp/test.sqlite",
  status: "ok" as const,
};

const fireConfig: FireScopeConfig = {
  currentAge: 35,
  expectedRealReturn: 0.05,
  monthlySpendingMinor: 200_000,
  safeWithdrawalRate: 0.04,
  targetRetirementAge: 55,
};

const fondo = createManualAsset(workspace, {
  currency: "EUR",
  currentValueMinor: 30_000_000,
  id: "asset_inv",
  liquidityTier: "market",
  name: "Fondo indexado",
  ownership: fullOwnership,
  type: "investment",
});

/** Two snapshots of the scope so the delta has two figures to compare. */
function snapshotPair(): NetWorthSnapshot[] {
  const summaryFor = (netWorthMinor: number): NetWorthSummary => ({
    debts: money(0, "EUR"),
    fxExcluded: [],
    grossAssets: money(netWorthMinor, "EUR"),
    housingEquity: money(0, "EUR"),
    liquidNetWorth: money(netWorthMinor, "EUR"),
    scopeId: scope.id,
    totalNetWorth: money(netWorthMinor, "EUR"),
  });

  return [
    createNetWorthSnapshot({
      capturedAt: "2026-05-01T00:00:00.000Z",
      id: "snap_1",
      scopeId: scope.id,
      scopeLabel: scope.label,
      summary: summaryFor(10_000_00),
    }),
    createNetWorthSnapshot({
      capturedAt: "2026-06-01T00:00:00.000Z",
      id: "snap_2",
      scopeId: scope.id,
      scopeLabel: scope.label,
      summary: summaryFor(12_000_00),
    }),
  ];
}

const baseInput: PrepareDashboardStateInput = {
  assets: [fondo],
  fireConfig: { household: { ...fireConfig, monthlySavingsCapacityMinor: 100_000 } },
  liabilities: [],
  persistence,
  positions: [],
  priceCache: [],
  scopes: [scope],
  selectedScope: scope,
  selectedView: "liquid",
  snapshots: snapshotPair(),
  today: "2026-06-25",
  workspace,
};

describe("resolveFireScopeConfig", () => {
  test("una sola respuesta a «¿está FIRE configurado?»", () => {
    expect(resolveFireScopeConfig(baseInput)).toMatchObject({
      monthlySpendingMinor: 200_000,
    });
    expect(resolveFireScopeConfig({ ...baseInput, selectedScope: undefined })).toBeNull();
    expect(resolveFireScopeConfig({ ...baseInput, fireConfig: {} })).toBeNull();
  });
});

describe("deriveNetWorthSurfaces", () => {
  test("las cinco superficies salen del ámbito seleccionado", () => {
    const surfaces = deriveNetWorthSurfaces({ ...baseInput, hasFireConfig: true });

    expect(surfaces.summary?.totalNetWorth.amountMinor).toBe(30_000_000);
    expect(surfaces.presentation).toBeDefined();
    expect(surfaces.pyramid.length).toBeGreaterThan(0);
    expect(surfaces.deltas?.changeSincePrevious?.amountMinor).toBe(2_000_00);
    expect(surfaces.onboarding.map((step) => step.done)).toEqual([
      true, // members
      true, // holdings
      true, // fire
      true, // snapshot
    ]);
  });

  test("sin ámbito no hay patrimonio, pero el delta sigue siendo legible", () => {
    // El delta compara dos snapshots entre sí: no necesita ni workspace ni ámbito.
    const surfaces = deriveNetWorthSurfaces({
      ...baseInput,
      hasFireConfig: false,
      selectedScope: undefined,
      workspace: null,
    });

    expect(surfaces.summary).toBeUndefined();
    expect(surfaces.presentation).toBeUndefined();
    expect(surfaces.pyramid).toEqual([]);
    expect(surfaces.deltas?.changeSincePrevious?.amountMinor).toBe(2_000_00);
    expect(surfaces.onboarding.map((step) => step.done)).toEqual([
      false, // members — sin workspace no hay miembros activos
      true,
      false, // fire
      true,
    ]);
  });

  test("la familia entera se apaga de una vez cuando nadie la va a leer (#1537)", () => {
    // /objetivos tira las cinco: apagarlas es una decisión, no cinco.
    expect(
      deriveNetWorthSurfaces({
        ...baseInput,
        hasFireConfig: true,
        includeNetWorthSurfaces: false,
      }),
    ).toEqual({
      deltas: undefined,
      onboarding: [],
      presentation: undefined,
      pyramid: [],
      summary: undefined,
    });
  });
});

describe("deriveFireSurfaces", () => {
  test("el resultado y la proyección salen del mismo contexto", () => {
    const fire = deriveFireSurfaces(baseInput, resolveFireScopeConfig(baseInput));

    expect(fire.fireResult?.percentFunded).toBeGreaterThan(0);
    expect(fire.fireProjection?.scenarios.some((s) => s.label === "base")).toBe(true);
    // El contrafactual del inmovilizado solo se calcula cuando alguien lo pide.
    expect(fire.fireResultImmobilizedFlipped).toBeNull();
  });

  test("el contrafactual del inmovilizado entra por la MISMA puerta (#1473)", () => {
    const fire = deriveFireSurfaces(
      { ...baseInput, includeFireImmobilizedCounterfactual: true },
      resolveFireScopeConfig(baseInput),
    );

    expect(fire.fireResultImmobilizedFlipped).not.toBeNull();
    expect(fire.fireResultImmobilizedFlipped?.context.config).toMatchObject({
      immobilizedCountsAsFireCapital: false,
    });
  });

  test("sin config FIRE no hay ninguna de las tres lecturas", () => {
    expect(deriveFireSurfaces(baseInput, null)).toEqual({
      fireProjection: null,
      fireResult: null,
      fireResultImmobilizedFlipped: null,
    });
  });

  test("la proyección se puede apagar sin perder el resultado (#1537)", () => {
    const fire = deriveFireSurfaces(
      { ...baseInput, includeFireProjection: false },
      resolveFireScopeConfig(baseInput),
    );

    expect(fire.fireResult).not.toBeNull();
    expect(fire.fireProjection).toBeNull();
  });
});

describe("deriveCoherences", () => {
  /** A monthly buy of 1.000 € for the 12 months ending 2026-06. */
  const buys: InvestmentOperation[] = Array.from({ length: 12 }, (_, i) => {
    const month = String(((6 + i) % 12) + 1).padStart(2, "0");
    const year = 6 + i >= 12 ? 2026 : 2025;
    return {
      assetId: "asset_inv",
      currency: "EUR" as const,
      executedAt: `${year}-${month}-10`,
      feesMinor: 0,
      id: `buy-${i}`,
      kind: "buy" as const,
      pricePerUnit: "1",
      units: "1000",
    };
  });

  test("el careo del ahorro mide el mismo libro que la señal de salud (#1449)", () => {
    const coherences = deriveCoherences(
      {
        ...baseInput,
        investmentOperationsByAssetId: new Map([["asset_inv", buys]]),
      },
      resolveFireScopeConfig(baseInput),
    );

    expect(coherences.savingsCoherence?.measuredMinor).toBeGreaterThan(0);
    expect(coherences.debtServiceCoherence).toBeNull();
  });

  test("el careo de la cuota nombra el supuesto declarado (#1520)", () => {
    const coherences = deriveCoherences(
      { ...baseInput, debtServiceByLiabilityId: new Map() },
      resolveFireScopeConfig(baseInput),
    );

    expect(coherences.debtServiceCoherence).not.toBeNull();
  });

  test("sin testigo el careo es null, nunca un cero inventado", () => {
    expect(deriveCoherences(baseInput, resolveFireScopeConfig(baseInput))).toEqual({
      debtServiceCoherence: null,
      savingsCoherence: null,
    });
    expect(deriveCoherences(baseInput, null)).toEqual({
      debtServiceCoherence: null,
      savingsCoherence: null,
    });
  });
});

describe("deriveFireGlance", () => {
  test("la tarjeta lee las cifras que ya se derivaron, no recalcula ninguna", () => {
    const fireScopeConfig = resolveFireScopeConfig(baseInput);
    const fire = deriveFireSurfaces(baseInput, fireScopeConfig);
    const glance = deriveFireGlance(baseInput, {
      fireProjection: fire.fireProjection,
      fireResult: fire.fireResult,
      fireScopeConfig,
      savingsCoherence: null,
    });

    expect(glance?.percentFunded).toBe(fire.fireResult?.percentFunded);
    expect(glance?.yearsToFire).toBe(
      fire.fireProjection?.scenarios.find((s) => s.label === "base")?.yearsToFire ?? null,
    );
    expect(glance?.goalsCount).toBe(0);
  });

  test("sin resultado FIRE no hay tarjeta", () => {
    expect(
      deriveFireGlance(baseInput, {
        fireProjection: null,
        fireResult: null,
        fireScopeConfig: resolveFireScopeConfig(baseInput),
        savingsCoherence: null,
      }),
    ).toBeNull();
  });
});

describe("prepareDashboardState es la composición de sus derivadores", () => {
  test("cada campo del estado ES la salida del derivador que lo produce", () => {
    const input: PrepareDashboardStateInput = {
      ...baseInput,
      debtServiceByLiabilityId: new Map(),
      includeFireImmobilizedCounterfactual: true,
    };
    const state = prepareDashboardState(input);
    const fireScopeConfig = resolveFireScopeConfig(input);
    const netWorth = deriveNetWorthSurfaces({
      ...input,
      hasFireConfig: fireScopeConfig !== null,
    });
    const fire = deriveFireSurfaces(input, fireScopeConfig);
    const coherences = deriveCoherences(input, fireScopeConfig);

    expect(state.summary).toEqual(netWorth.summary);
    expect(state.presentation).toEqual(netWorth.presentation);
    expect(state.pyramid).toEqual(netWorth.pyramid);
    expect(state.deltas).toEqual(netWorth.deltas);
    expect(state.onboarding).toEqual(netWorth.onboarding);
    expect(state.fireResult).toEqual(fire.fireResult);
    expect(state.fireResultImmobilizedFlipped).toEqual(fire.fireResultImmobilizedFlipped);
    expect(state.fireProjection).toEqual(fire.fireProjection);
    expect(state.savingsCoherence).toEqual(coherences.savingsCoherence);
    expect(state.debtServiceCoherence).toEqual(coherences.debtServiceCoherence);
    expect(state.fireGlance).toEqual(
      deriveFireGlance(input, {
        fireProjection: fire.fireProjection,
        fireResult: fire.fireResult,
        fireScopeConfig,
        savingsCoherence: coherences.savingsCoherence,
      }),
    );
    expect(state.fireScopeConfig).toEqual(fireScopeConfig);
  });
});
