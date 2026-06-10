/**
 * Tests for the drilldown state module (#76).
 *
 * buildLiquidDrilldown: snapshot holding rows + current portfolio → drill view
 * state for the liquid group (cash + market tiers):
 * - per-tier stacked series over time (net = assets − liabilities per frozen
 *   tier), with the deterministic stack→lines fallback and the <2 points rule
 * - per-holding sparkline entries for holdings with ≥2 captured points,
 *   carrying the frozen label and the current value when still held
 */
import { describe, expect, test } from "vitest";

import type { DatedSnapshotHoldingRow } from "./drilldown";
import {
  buildHousingDrilldown,
  buildLiquidDrilldown,
  buildRestDrilldown,
  DRILL_SPARKLINE_HEIGHT,
  DRILL_SPARKLINE_INSET_X,
  DRILL_SPARKLINE_WIDTH,
} from "./drilldown";
import type { LiquidityTier } from "./classification";
import type { SnapshotHoldingKind } from "./snapshot-holdings";

function row(input: {
  dateKey: string;
  holdingId: string;
  tier: LiquidityTier | null;
  valueMinor: number;
  kind?: SnapshotHoldingKind;
  label?: string;
}): DatedSnapshotHoldingRow {
  return {
    dateKey: input.dateKey,
    holdingId: input.holdingId,
    kind: input.kind ?? "asset",
    label: input.label ?? input.holdingId,
    liquidityTier: input.tier,
    valueMinor: input.valueMinor,
  };
}

describe("buildLiquidDrilldown — group resolution", () => {
  test("only cash and market rows participate; other tiers are excluded", () => {
    const rows = [
      row({ dateKey: "2026-06-01", holdingId: "a_cash", tier: "cash", valueMinor: 100 }),
      row({ dateKey: "2026-06-01", holdingId: "a_house", tier: "housing", valueMinor: 999 }),
      row({ dateKey: "2026-06-01", holdingId: "a_pension", tier: "retirement", valueMinor: 999 }),
      row({ dateKey: "2026-06-01", holdingId: "a_art", tier: "illiquid", valueMinor: 999 }),
      row({ dateKey: "2026-06-01", holdingId: "l_loan", tier: null, valueMinor: 999, kind: "liability" }),
      row({ dateKey: "2026-06-02", holdingId: "a_cash", tier: "cash", valueMinor: 200 }),
      row({ dateKey: "2026-06-02", holdingId: "a_house", tier: "housing", valueMinor: 999 }),
    ];

    const state = buildLiquidDrilldown({ currentHoldingIds: ["a_cash"], rows });

    expect(state.key).toBe("liquid");
    expect(state.stack).not.toBeNull();
    expect(state.stack!.bands.map((b) => b.band)).toEqual(["cash", "market"]);
    expect(state.holdings.map((h) => h.holdingId)).toEqual(["a_cash"]);
  });
});

describe("buildLiquidDrilldown — per-tier stacked series", () => {
  test("returns null stack below the two-point placeholder threshold", () => {
    const rows = [
      row({ dateKey: "2026-06-10", holdingId: "a_cash", tier: "cash", valueMinor: 100 }),
      row({ dateKey: "2026-06-10", holdingId: "a_fund", tier: "market", valueMinor: 200 }),
    ];

    const state = buildLiquidDrilldown({ currentHoldingIds: ["a_cash", "a_fund"], rows });

    expect(state.stack).toBeNull();
    expect(state.holdings).toEqual([]);
  });

  test("stacks cash and market nets (assets − liabilities per frozen tier)", () => {
    const rows = [
      row({ dateKey: "2026-06-01", holdingId: "a_cash", tier: "cash", valueMinor: 100_00 }),
      row({ dateKey: "2026-06-01", holdingId: "l_margin", tier: "cash", valueMinor: 40_00, kind: "liability" }),
      row({ dateKey: "2026-06-01", holdingId: "a_fund", tier: "market", valueMinor: 100_00 }),
      row({ dateKey: "2026-06-02", holdingId: "a_cash", tier: "cash", valueMinor: 120_00 }),
      row({ dateKey: "2026-06-02", holdingId: "l_margin", tier: "cash", valueMinor: 40_00, kind: "liability" }),
      row({ dateKey: "2026-06-02", holdingId: "a_fund", tier: "market", valueMinor: 100_00 }),
    ];

    const state = buildLiquidDrilldown({ currentHoldingIds: [], rows });

    expect(state.stack).not.toBeNull();
    expect(state.stack!.mode).toBe("stacked");
    // Stacked domain includes the zero baseline; top edge is the group net:
    // day 1 → cash 60 + market 100 = 160, day 2 → 80 + 100 = 180.
    // Padded by 10% of the [0, 180] range.
    expect(state.stack!.yMin).toBe(-18_00);
    expect(state.stack!.yMax).toBe(198_00);
    for (const band of state.stack!.bands) {
      expect(band.areaPoints).not.toBeNull();
    }
  });

  test("falls back to lines for the whole window when a tier net crosses zero", () => {
    const rows = [
      row({ dateKey: "2026-06-01", holdingId: "a_cash", tier: "cash", valueMinor: 100_00 }),
      row({ dateKey: "2026-06-01", holdingId: "a_fund", tier: "market", valueMinor: 50_00 }),
      row({ dateKey: "2026-06-02", holdingId: "a_cash", tier: "cash", valueMinor: 100_00 }),
      row({ dateKey: "2026-06-02", holdingId: "l_margin", tier: "market", valueMinor: 70_00, kind: "liability" }),
      row({ dateKey: "2026-06-02", holdingId: "a_fund", tier: "market", valueMinor: 50_00 }),
    ];

    const state = buildLiquidDrilldown({ currentHoldingIds: [], rows });

    expect(state.stack).not.toBeNull();
    expect(state.stack!.mode).toBe("lines");
    for (const band of state.stack!.bands) {
      expect(band.areaPoints).toBeNull();
      expect(band.linePoints.length).toBeGreaterThan(0);
    }
  });

  test("a tier with no rows still gets a band with zero values", () => {
    const rows = [
      row({ dateKey: "2026-06-01", holdingId: "a_cash", tier: "cash", valueMinor: 100_00 }),
      row({ dateKey: "2026-06-02", holdingId: "a_cash", tier: "cash", valueMinor: 200_00 }),
    ];

    const state = buildLiquidDrilldown({ currentHoldingIds: [], rows });

    expect(state.stack!.bands.map((b) => b.band)).toEqual(["cash", "market"]);
    expect(state.stack!.mode).toBe("stacked");
  });
});

describe("buildLiquidDrilldown — per-holding small multiples", () => {
  test("one entry per holding with ≥2 captured points; single-point holdings are excluded", () => {
    const rows = [
      row({ dateKey: "2026-06-01", holdingId: "a_cash", tier: "cash", valueMinor: 100, label: "Cuenta" }),
      row({ dateKey: "2026-06-02", holdingId: "a_cash", tier: "cash", valueMinor: 200, label: "Cuenta" }),
      row({ dateKey: "2026-06-02", holdingId: "a_fund", tier: "market", valueMinor: 500, label: "Fondo" }),
    ];

    const state = buildLiquidDrilldown({ currentHoldingIds: ["a_cash", "a_fund"], rows });

    expect(state.holdings).toHaveLength(1);
    expect(state.holdings[0]).toMatchObject({
      holdingId: "a_cash",
      kind: "asset",
      label: "Cuenta",
      tier: "cash",
    });
  });

  test("sparkline geometry uses time-proportional xs over a padded domain", () => {
    const rows = [
      row({ dateKey: "2026-06-01", holdingId: "a_cash", tier: "cash", valueMinor: 100 }),
      row({ dateKey: "2026-06-02", holdingId: "a_cash", tier: "cash", valueMinor: 200 }),
    ];

    const state = buildLiquidDrilldown({ currentHoldingIds: ["a_cash"], rows });

    const sparkline = state.holdings[0]!.sparkline;
    expect(sparkline.width).toBe(DRILL_SPARKLINE_WIDTH);
    expect(sparkline.height).toBe(DRILL_SPARKLINE_HEIGHT);
    // xs: inset → width − inset. ys: padded domain [90, 210] over height 36.
    const inset = DRILL_SPARKLINE_INSET_X;
    expect(sparkline.linePoints).toBe(
      `${inset},33 ${DRILL_SPARKLINE_WIDTH - inset},3`,
    );
  });

  test("current value comes from the latest capture when the holding is still held", () => {
    const rows = [
      row({ dateKey: "2026-06-01", holdingId: "a_cash", tier: "cash", valueMinor: 100 }),
      row({ dateKey: "2026-06-02", holdingId: "a_cash", tier: "cash", valueMinor: 250 }),
    ];

    const state = buildLiquidDrilldown({ currentHoldingIds: ["a_cash"], rows });

    expect(state.holdings[0]!.currentValueMinor).toBe(250);
  });

  test("a holding no longer in the portfolio has no current value", () => {
    const rows = [
      row({ dateKey: "2026-06-01", holdingId: "a_sold", tier: "market", valueMinor: 100 }),
      row({ dateKey: "2026-06-02", holdingId: "a_sold", tier: "market", valueMinor: 120 }),
    ];

    const state = buildLiquidDrilldown({ currentHoldingIds: [], rows });

    expect(state.holdings[0]!.currentValueMinor).toBeNull();
  });

  test("frozen label and tier come from the latest capture of the holding", () => {
    const rows = [
      row({ dateKey: "2026-06-01", holdingId: "a_x", tier: "cash", valueMinor: 100, label: "Vieja" }),
      row({ dateKey: "2026-06-02", holdingId: "a_x", tier: "market", valueMinor: 120, label: "Nueva" }),
    ];

    const state = buildLiquidDrilldown({ currentHoldingIds: ["a_x"], rows });

    expect(state.holdings[0]!.label).toBe("Nueva");
    expect(state.holdings[0]!.tier).toBe("market");
  });

  test("holdings are ordered by label for a stable presentation", () => {
    const rows = [
      row({ dateKey: "2026-06-01", holdingId: "a_z", tier: "market", valueMinor: 1, label: "Zeta" }),
      row({ dateKey: "2026-06-02", holdingId: "a_z", tier: "market", valueMinor: 2, label: "Zeta" }),
      row({ dateKey: "2026-06-01", holdingId: "a_a", tier: "cash", valueMinor: 1, label: "Alfa" }),
      row({ dateKey: "2026-06-02", holdingId: "a_a", tier: "cash", valueMinor: 2, label: "Alfa" }),
    ];

    const state = buildLiquidDrilldown({ currentHoldingIds: [], rows });

    expect(state.holdings.map((h) => h.label)).toEqual(["Alfa", "Zeta"]);
  });
});

describe("buildRestDrilldown — group resolution (#77)", () => {
  test("only retirement and illiquid rows participate; other tiers are excluded", () => {
    const rows = [
      row({ dateKey: "2026-06-01", holdingId: "a_pension", tier: "retirement", valueMinor: 100 }),
      row({ dateKey: "2026-06-01", holdingId: "a_art", tier: "illiquid", valueMinor: 50 }),
      row({ dateKey: "2026-06-01", holdingId: "a_cash", tier: "cash", valueMinor: 999 }),
      row({ dateKey: "2026-06-01", holdingId: "a_house", tier: "housing", valueMinor: 999 }),
      row({ dateKey: "2026-06-01", holdingId: "l_loan", tier: null, valueMinor: 999, kind: "liability" }),
      row({ dateKey: "2026-06-02", holdingId: "a_pension", tier: "retirement", valueMinor: 120 }),
      row({ dateKey: "2026-06-02", holdingId: "a_art", tier: "illiquid", valueMinor: 50 }),
      row({ dateKey: "2026-06-02", holdingId: "a_cash", tier: "cash", valueMinor: 999 }),
    ];

    const state = buildRestDrilldown({ currentHoldingIds: ["a_pension", "a_art"], rows });

    expect(state.key).toBe("rest");
    expect(state.stack).not.toBeNull();
    expect(state.stack!.bands.map((b) => b.band)).toEqual(["retirement", "illiquid"]);
    expect(state.holdings.map((h) => h.holdingId)).toEqual(["a_art", "a_pension"]);
  });

  test("stacks retirement and illiquid nets with the deterministic stack→lines fallback", () => {
    const rows = [
      row({ dateKey: "2026-06-01", holdingId: "a_pension", tier: "retirement", valueMinor: 100_00 }),
      row({ dateKey: "2026-06-01", holdingId: "a_art", tier: "illiquid", valueMinor: 50_00 }),
      row({ dateKey: "2026-06-02", holdingId: "a_pension", tier: "retirement", valueMinor: 110_00 }),
      row({ dateKey: "2026-06-02", holdingId: "l_art_loan", tier: "illiquid", valueMinor: 70_00, kind: "liability" }),
      row({ dateKey: "2026-06-02", holdingId: "a_art", tier: "illiquid", valueMinor: 50_00 }),
    ];

    // Illiquid net dips below zero on day 2 → the whole window becomes lines.
    const state = buildRestDrilldown({ currentHoldingIds: [], rows });

    expect(state.stack).not.toBeNull();
    expect(state.stack!.mode).toBe("lines");
    for (const band of state.stack!.bands) {
      expect(band.areaPoints).toBeNull();
    }
  });

  test("returns null stack below the two-point placeholder threshold", () => {
    const rows = [
      row({ dateKey: "2026-06-10", holdingId: "a_pension", tier: "retirement", valueMinor: 100 }),
    ];

    const state = buildRestDrilldown({ currentHoldingIds: ["a_pension"], rows });

    expect(state.stack).toBeNull();
    expect(state.holdings).toEqual([]);
  });
});

describe("buildHousingDrilldown — single-tier group (#77)", () => {
  test("only housing rows participate and the key is housing", () => {
    const rows = [
      row({ dateKey: "2026-06-01", holdingId: "a_piso", tier: "housing", valueMinor: 300_000_00, label: "Piso" }),
      row({ dateKey: "2026-06-01", holdingId: "a_cash", tier: "cash", valueMinor: 999 }),
      row({ dateKey: "2026-06-01", holdingId: "a_pension", tier: "retirement", valueMinor: 999 }),
      row({ dateKey: "2026-06-02", holdingId: "a_piso", tier: "housing", valueMinor: 320_000_00, label: "Piso" }),
    ];

    const state = buildHousingDrilldown({ currentHoldingIds: ["a_piso"], rows });

    expect(state.key).toBe("housing");
    expect(state.holdings.map((h) => h.holdingId)).toEqual(["a_piso"]);
  });

  test("never builds a stack, even with multi-day data", () => {
    const rows = [
      row({ dateKey: "2026-06-01", holdingId: "a_piso", tier: "housing", valueMinor: 300_000_00 }),
      row({ dateKey: "2026-06-02", holdingId: "a_piso", tier: "housing", valueMinor: 320_000_00 }),
    ];

    const state = buildHousingDrilldown({ currentHoldingIds: ["a_piso"], rows });

    expect(state.stack).toBeNull();
  });

  test("per-property small multiples answer which property revalued more", () => {
    const rows = [
      row({ dateKey: "2026-06-01", holdingId: "a_piso", tier: "housing", valueMinor: 300_000_00, label: "Piso" }),
      row({ dateKey: "2026-06-01", holdingId: "a_atico", tier: "housing", valueMinor: 200_000_00, label: "Ático" }),
      row({ dateKey: "2026-06-02", holdingId: "a_piso", tier: "housing", valueMinor: 320_000_00, label: "Piso" }),
      row({ dateKey: "2026-06-02", holdingId: "a_atico", tier: "housing", valueMinor: 200_000_00, label: "Ático" }),
    ];

    const state = buildHousingDrilldown({ currentHoldingIds: ["a_piso", "a_atico"], rows });

    expect(state.holdings.map((h) => h.label)).toEqual(["Ático", "Piso"]);
    expect(state.holdings.map((h) => h.currentValueMinor)).toEqual([
      200_000_00,
      320_000_00,
    ]);
    for (const holding of state.holdings) {
      expect(holding.tier).toBe("housing");
      expect(holding.sparkline.linePoints.length).toBeGreaterThan(0);
    }
  });
});
