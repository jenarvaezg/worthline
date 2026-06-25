import { describe, expect, test } from "vitest";

import {
  createManualAsset,
  createWorkspace,
  largestRemainderPercentages,
  prepareDashboardState,
} from "./index";
import type { FireScopeConfig } from "./index";

const workspace = createWorkspace({
  members: [{ id: "member_jose", name: "Jose" }],
  mode: "individual",
});
const fullOwnership = [{ memberId: "member_jose", shareBps: 10_000 }];

const persistence = {
  checkKey: "bootstrap",
  checkedAt: "2026-06-01T12:00:00.000Z",
  checkValue: "2026-06-01T12:00:00.000Z",
  databasePath: "/tmp/test.sqlite",
  displayPath: "/tmp/test.sqlite",
  status: "ok" as const,
};

describe("prepareDashboardState", () => {
  test("returns empty state when no workspace exists", () => {
    const state = prepareDashboardState({
      assets: [],
      fireConfig: {},
      liabilities: [],
      persistence,
      positions: [],
      priceCache: [],
      scopes: [],
      selectedScope: undefined,
      selectedView: "liquid",
      snapshots: [],
      workspace: null,
    });

    expect(state.workspace).toBeNull();
    expect(state.summary).toBeUndefined();
    expect(state.presentation).toBeUndefined();
    expect(state.fireResult).toBeNull();
    expect(state.pyramid).toEqual([]);
    expect(state.warnings).toEqual([]);
    expect(state.dashboard.productName).toBe("worthline");
  });

  test("computes summary, pyramid, and warnings for a workspace with assets", () => {
    const cash = createManualAsset(workspace, {
      currency: "EUR",
      currentValueMinor: 0,
      id: "asset_cash",
      liquidityTier: "cash",
      name: "Cuenta vacia",
      ownership: fullOwnership,
      type: "cash",
    });

    const state = prepareDashboardState({
      assets: [cash],
      fireConfig: {},
      liabilities: [],
      persistence,
      positions: [],
      priceCache: [],
      scopes: [{ id: "household", label: "Hogar", type: "household" }],
      selectedScope: { id: "household", label: "Hogar", type: "household" },
      selectedView: "liquid",
      snapshots: [],
      workspace,
    });

    expect(state.summary).toBeDefined();
    expect(state.summary!.grossAssets.amountMinor).toBe(0);
    expect(state.pyramid).toHaveLength(5);
    expect(state.warnings).toHaveLength(1);
    expect(state.warnings[0]!.code).toBe("ZERO_VALUE_ASSET");
    expect(state.dashboard.generatedAt).toBeDefined();
  });
});

describe("fireGlance in prepareDashboardState", () => {
  const fireConfig: FireScopeConfig = {
    monthlySpendingMinor: 200_000, // 2000 €/month
    safeWithdrawalRate: 0.04,
    expectedRealReturn: 0.05,
    currentAge: 35,
    targetRetirementAge: 55,
  };

  // fireNumber = 2000*12/0.04 = 600_000 €
  // coastFireRequired = 600_000 / (1.05^20) ≈ 226_102 €
  const investmentAsset = createManualAsset(workspace, {
    currency: "EUR",
    currentValueMinor: 30_000_000, // 300_000 € → 50% funded
    id: "asset_inv",
    liquidityTier: "market",
    name: "Fondo indexado",
    ownership: fullOwnership,
    type: "investment",
  });

  const scope = { id: "household", label: "Hogar", type: "household" as const };

  test("returns populated fireGlance when FIRE is configured", () => {
    const state = prepareDashboardState({
      assets: [investmentAsset],
      fireConfig: { household: fireConfig },
      liabilities: [],
      persistence,
      positions: [],
      priceCache: [],
      scopes: [scope],
      selectedScope: scope,
      selectedView: "liquid",
      snapshots: [],
      workspace,
    });

    expect(state.fireGlance).not.toBeNull();
    const glance = state.fireGlance!;
    expect(glance.percentFunded).toBeGreaterThan(0);
    expect(glance.percentFunded).toBeLessThan(100);
    // coastTickFraction: coastRequired / fireNumber (both > 0)
    expect(glance.coastTickFraction).not.toBeNull();
    expect(glance.coastTickFraction).toBeGreaterThan(0);
    expect(glance.coastTickFraction).toBeLessThan(1);
    // yearsToFire matches the base scenario exactly.
    const baseScenario = state.fireProjection!.scenarios.find((s) => s.label === "base");
    expect(glance.yearsToFire).toBe(baseScenario!.yearsToFire);
    expect(glance.goalsCount).toBe(0);
    expect(glance.goalsReservedMinor).toBe(0);
  });

  test("returns fireGlance with goals data when goals are provided", () => {
    const state = prepareDashboardState({
      assets: [investmentAsset],
      fireConfig: { household: fireConfig },
      goals: [
        {
          id: "goal_1",
          name: "Coche",
          // Target < asset value so reservation is capped at target.
          targetAmountMinor: 2_000_000,
          deadline: "2030-01-01",
          priority: "high",
          scopeId: "household",
          // Assigned to the funded asset → reservation will be positive.
          assetIds: ["asset_inv"],
        },
        {
          id: "goal_2",
          name: "Viaje",
          targetAmountMinor: 500_000,
          deadline: "2028-06-01",
          priority: "medium",
          scopeId: "household",
          assetIds: [],
        },
      ],
      liabilities: [],
      persistence,
      positions: [],
      priceCache: [],
      scopes: [scope],
      selectedScope: scope,
      selectedView: "liquid",
      snapshots: [],
      today: "2026-06-25",
      workspace,
    });

    expect(state.fireGlance).not.toBeNull();
    const glance = state.fireGlance!;
    expect(glance.goalsCount).toBe(2);
    // Reservation must be positive (goal_1 is assigned to the funded asset).
    expect(glance.goalsReservedMinor).toBeGreaterThan(0);
    // Must match the clamped value FIRE actually subtracted — not the raw pre-clamp total.
    expect(glance.goalsReservedMinor).toBe(
      state.fireResult!.reservedForGoals!.amountMinor,
    );
  });

  test("returns null fireGlance when FIRE is not configured", () => {
    const state = prepareDashboardState({
      assets: [investmentAsset],
      fireConfig: {},
      liabilities: [],
      persistence,
      positions: [],
      priceCache: [],
      scopes: [scope],
      selectedScope: scope,
      selectedView: "liquid",
      snapshots: [],
      workspace,
    });

    expect(state.fireGlance).toBeNull();
  });
});

describe("largestRemainderPercentages", () => {
  test("returns zeros for empty input", () => {
    expect(largestRemainderPercentages([])).toEqual([]);
  });

  test("single value gets 100%", () => {
    expect(largestRemainderPercentages([500])).toEqual([100]);
  });

  test("even split sums to 100", () => {
    const result = largestRemainderPercentages([1, 1, 1]);
    expect(result.reduce((a, b) => a + b, 0)).toBe(100);
  });

  test("uneven split gives the leftover point to the largest distinct remainder", () => {
    // 33.2%, 33.3%, 33.5% — naive floor gives 33+33+33=99.
    // The leftover 1% must go to the third value; an inverted comparator would
    // give it to the first.
    const result = largestRemainderPercentages([332, 333, 335]);
    expect(result.reduce((a, b) => a + b, 0)).toBe(100);
    expect(result).toEqual([33, 33, 34]);
  });

  test("zero values get 0% with no division by zero", () => {
    const result = largestRemainderPercentages([0, 0, 0]);
    expect(result).toEqual([0, 0, 0]);
  });

  test("preserves order of input values", () => {
    // 60% + 40% = exact split → no remainder needed.
    const result = largestRemainderPercentages([600, 400]);
    expect(result).toEqual([60, 40]);
  });
});
