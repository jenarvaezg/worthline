import { describe, expect, test } from "vitest";

import {
  createManualAsset,
  createWorkspace,
  largestRemainderPercentages,
  prepareDashboardState,
  signedDeltaBarWidths,
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

  test("uneven split sums to exactly 100 via largest remainder", () => {
    // Three equal bps values — naive floor gives 33+33+33=99, remainder fixes it.
    const result = largestRemainderPercentages([10_000, 10_000, 10_000]);
    expect(result.reduce((a, b) => a + b, 0)).toBe(100);
    // Largest remainder allocates the leftover 1% to the first group.
    expect(result).toEqual([34, 33, 33]);
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

describe("signedDeltaBarWidths", () => {
  test("returns zeros for empty input", () => {
    expect(signedDeltaBarWidths([])).toEqual([]);
  });

  test("single value gets max width 100", () => {
    expect(signedDeltaBarWidths([500_00])).toEqual([100]);
  });

  test("negative value has same magnitude scaling as positive", () => {
    const result = signedDeltaBarWidths([-1000_00, 1000_00]);
    expect(result).toEqual([100, 100]);
  });

  test("zero delta gets width 0", () => {
    const result = signedDeltaBarWidths([0, 1000_00]);
    expect(result[0]).toBe(0);
    expect(result[1]).toBe(100);
  });

  test("scales proportionally to the absolute max", () => {
    // max = 200, first value = 100 → 50%
    const result = signedDeltaBarWidths([100_00, 200_00]);
    expect(result[0]).toBe(50);
    expect(result[1]).toBe(100);
  });
});
