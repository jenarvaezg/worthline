import { describe, expect, test } from "vitest";

import {
  createManualAsset,
  createWorkspace,
  prepareDashboardState,
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
    expect(state.dashboard.metrics[0]!.value.amountMinor).toBe(0);
  });
});
