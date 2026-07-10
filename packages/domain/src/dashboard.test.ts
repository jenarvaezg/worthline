import { describe, expect, test } from "vitest";
import type { FireScopeConfig } from "./index";
import {
  createManualAsset,
  createWorkspace,
  goalFireDelay,
  goalFundedRatioBps,
  goalReservedMinor,
  largestRemainderPercentages,
  prepareDashboardState,
  prepareObjetivosState,
} from "./index";

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

  test("uses the contribution plan's derived monthly savings for FIRE projection", () => {
    const state = prepareDashboardState({
      assets: [investmentAsset],
      contributionPlan: {
        scopeId: "household",
        contributions: [
          {
            id: "contrib_1",
            destinationHoldingId: "asset_inv",
            amount: { mode: "money", value: 500_000 },
            cadence: { kind: "monthly", dayOfMonth: 1 },
            startDate: "2026-01-01",
          },
        ],
      },
      fireConfig: {
        household: {
          ...fireConfig,
          monthlySavingsCapacityMinor: 100_000,
        },
      },
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

    const manualOnly = prepareDashboardState({
      assets: [investmentAsset],
      fireConfig: {
        household: {
          ...fireConfig,
          monthlySavingsCapacityMinor: 100_000,
        },
      },
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

    const planBase = state.fireProjection!.scenarios.find((s) => s.label === "base")!;
    const manualBase = manualOnly.fireProjection!.scenarios.find(
      (s) => s.label === "base",
    )!;
    expect(planBase.totalContributedMinor).toBeGreaterThan(
      manualBase.totalContributedMinor,
    );
  });

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

  test("does not reserve FIRE capital from a goal assigned only to an excluded asset", () => {
    const excludedAsset = createManualAsset(workspace, {
      currency: "EUR",
      currentValueMinor: 20_000_000,
      id: "asset_excluded",
      liquidityTier: "market",
      name: "Plan excluido",
      ownership: fullOwnership,
      type: "investment",
    });
    const eligibleAsset = createManualAsset(workspace, {
      currency: "EUR",
      currentValueMinor: 30_000_000,
      id: "asset_eligible",
      liquidityTier: "market",
      name: "Fondo elegible",
      ownership: fullOwnership,
      type: "investment",
    });

    const state = prepareDashboardState({
      assets: [excludedAsset, eligibleAsset],
      fireConfig: {
        household: { ...fireConfig, excludedAssetIds: ["asset_excluded"] },
      },
      goals: [
        {
          id: "goal_excluded",
          name: "Coche",
          targetAmountMinor: 5_000_000,
          deadline: "2030-01-01",
          priority: "high",
          scopeId: "household",
          assetIds: ["asset_excluded"],
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

    expect(state.fireResult!.eligibleAssets.amountMinor).toBe(30_000_000);
    expect(state.fireResult!.reservedForGoals!.amountMinor).toBe(0);
    expect(state.fireGlance!.goalsReservedMinor).toBe(0);
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

describe("prepareObjetivosState", () => {
  const fireConfig: FireScopeConfig = {
    monthlySpendingMinor: 200_000,
    safeWithdrawalRate: 0.04,
    expectedRealReturn: 0.05,
    currentAge: 35,
    targetRetirementAge: 55,
  };

  const investmentAsset = createManualAsset(workspace, {
    currency: "EUR",
    currentValueMinor: 30_000_000,
    id: "asset_obj_inv",
    liquidityTier: "market",
    name: "Fondo",
    ownership: [{ memberId: "member_jose", shareBps: 10_000 }],
    type: "investment",
  });

  const scope = { id: "household", label: "Hogar", type: "household" as const };

  const goal = {
    id: "goal_obj_1",
    name: "Coche",
    targetAmountMinor: 2_000_000,
    deadline: "2030-01-01",
    priority: "high" as const,
    scopeId: "household",
    assetIds: ["asset_obj_inv"],
  };

  const baseInput = {
    assets: [investmentAsset],
    fireConfig: { household: fireConfig },
    goals: [goal],
    liabilities: [],
    persistence,
    positions: [],
    priceCache: [],
    scopes: [scope],
    selectedScope: scope,
    selectedView: "liquid" as const,
    snapshots: [],
    today: "2026-06-25",
    workspace,
  };

  test("FIRE bits match prepareDashboardState exactly", () => {
    const dash = prepareDashboardState(baseInput);
    const obj = prepareObjetivosState(baseInput);

    expect(obj.fireProjection).toEqual(dash.fireProjection);
    expect(obj.fireResult).toEqual(dash.fireResult);
    expect(obj.fireScopeConfig).toEqual(dash.fireScopeConfig);
  });

  test("per-goal fundedRatioBps and reservedMinor match existing helpers", () => {
    const obj = prepareObjetivosState(baseInput);

    expect(obj.goals).toHaveLength(1);
    const g = obj.goals[0]!;

    // assignedValueMinor for goal_obj_1: the whole asset (full ownership, household scope)
    const assignedMinor = 30_000_000;
    expect(g.fundedRatioBps).toBe(
      goalFundedRatioBps(goal.targetAmountMinor, assignedMinor),
    );
    expect(g.reservedMinor).toBe(
      goalReservedMinor(goal.targetAmountMinor, assignedMinor),
    );
    // capped at target → 2_000_000
    expect(g.reservedMinor).toBe(2_000_000);
    // fully funded → 10 000 bps
    expect(g.fundedRatioBps).toBe(10_000);
  });

  test("over-target goal is clamped at 10 000 bps funded", () => {
    const overTarget = { ...goal, targetAmountMinor: 1_000 }; // target well below asset value
    const obj = prepareObjetivosState({ ...baseInput, goals: [overTarget] });
    expect(obj.goals[0]!.fundedRatioBps).toBe(10_000);
    expect(obj.goals[0]!.reservedMinor).toBe(1_000);
  });

  test("goal with no assigned assets has 0 funded and 0 reserved", () => {
    const emptyGoal = { ...goal, assetIds: [] };
    const obj = prepareObjetivosState({ ...baseInput, goals: [emptyGoal] });
    expect(obj.goals[0]!.fundedRatioBps).toBe(0);
    expect(obj.goals[0]!.reservedMinor).toBe(0);
  });

  test("returns null FIRE fields when unconfigured", () => {
    const obj = prepareObjetivosState({ ...baseInput, fireConfig: {} });
    expect(obj.fireResult).toBeNull();
    expect(obj.fireProjection).toBeNull();
    expect(obj.fireScopeConfig).toBeNull();
  });

  test("countsTowardFire is true for a goal within the FIRE horizon", () => {
    // fireConfig has currentAge:35, targetRetirementAge:55 → horizon = today+20y
    const obj = prepareObjetivosState({ ...baseInput, today: "2026-06-25" });
    // goal deadline "2030-01-01" is after now and before the ~2046 horizon
    expect(obj.goals[0]!.countsTowardFire).toBe(true);
  });

  test("countsTowardFire is false for a past-deadline goal", () => {
    const pastGoal = { ...goal, deadline: "2020-01-01" };
    const obj = prepareObjetivosState({
      ...baseInput,
      goals: [pastGoal],
      today: "2026-06-25",
    });
    expect(obj.goals[0]!.countsTowardFire).toBe(false);
  });

  test("countsTowardFire is false for a goal due after the FIRE horizon", () => {
    // horizon = 2026+20 = 2046; goal due 2060 is after it
    const farGoal = { ...goal, deadline: "2060-01-01" };
    const obj = prepareObjetivosState({
      ...baseInput,
      goals: [farGoal],
      today: "2026-06-25",
    });
    expect(obj.goals[0]!.countsTowardFire).toBe(false);
  });

  test("coastTickFraction is clamped to [0,1] and matches fireGlance", () => {
    const obj = prepareObjetivosState(baseInput);
    if (obj.coastTickFraction !== null) {
      expect(obj.coastTickFraction).toBeGreaterThanOrEqual(0);
      expect(obj.coastTickFraction).toBeLessThanOrEqual(1);
    }
    // Must equal what prepareDashboardState puts in fireGlance
    const dash = prepareDashboardState(baseInput);
    expect(obj.coastTickFraction).toBe(dash.fireGlance?.coastTickFraction ?? null);
  });

  test("per-goal fireDelay matches a direct goalFireDelay call (wiring correctness)", () => {
    const obj = prepareObjetivosState(baseInput);
    expect(obj.goals).toHaveLength(1);
    const g = obj.goals[0]!;

    // Reconstruct what the wiring should compute.
    // eligibleGrossMinor = eligible (after reservation) + reserved
    const dash = prepareDashboardState(baseInput);
    const eligibleGrossMinor =
      dash.fireResult!.eligibleAssets.amountMinor +
      (dash.fireResult!.reservedForGoals?.amountMinor ?? 0);

    // The one goal is in-horizon (deadline 2030-01-01 < horizon ~2046) so
    // thisGoalReservation = min(target, assignedValue) = min(2M, 30M) = 2M.
    // otherReservationsMinor = 0 (no other goals).
    // in-horizon reservation = min(target=2M, assignedValue=30M) = 2M
    const direct = goalFireDelay({
      goal,
      otherReservationsMinor: 0,
      eligibleGrossMinor,
      thisGoalReservationMinor: 2_000_000,
      config: fireConfig,
      now: "2026-06-25",
    });

    expect(g.fireDelay).toEqual(direct);
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
