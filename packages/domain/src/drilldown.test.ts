/**
 * Tests for the drilldown state module (#76).
 *
 * buildLiquidDrilldown: snapshot holding rows + current portfolio → drill view
 * state for the liquid group (cash + market tiers):
 * - per-tier stacked series over time (net = assets − liabilities per frozen
 *   tier), with the deterministic stack→lines fallback and the <2 points rule
 * - per-holding sparkline entries for holdings with ≥2 captured points,
 *   carrying the frozen label and the current value when still held
 * - the no-longer-held rule (#78): sold/removed holdings keep their history,
 *   truncated at their last capture on the window's shared time axis, flagged
 *   and ordered after the currently-held ones
 */
import { describe, expect, test } from "vitest";

import type { DatedSnapshotHoldingRow } from "./drilldown";
import {
  buildDebtsDrilldown,
  buildDrilldown,
  buildHousingDrilldown,
  buildLiquidDrilldown,
  buildRestDrilldown,
  DRILL_GROUP_BY_TIER,
  DRILL_SPARKLINE_HEIGHT,
  DRILL_SPARKLINE_INSET_X,
  DRILL_SPARKLINE_WIDTH,
  LIQUID_DRILL_TIERS,
  REST_DRILL_TIERS,
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
      row({
        dateKey: "2026-06-01",
        holdingId: "a_house",
        tier: "illiquid",
        valueMinor: 999,
      }),
      row({
        dateKey: "2026-06-01",
        holdingId: "a_pension",
        tier: "term-locked",
        valueMinor: 999,
      }),
      row({
        dateKey: "2026-06-01",
        holdingId: "a_art",
        tier: "illiquid",
        valueMinor: 999,
      }),
      row({
        dateKey: "2026-06-01",
        holdingId: "l_loan",
        tier: null,
        valueMinor: 999,
        kind: "liability",
      }),
      row({ dateKey: "2026-06-02", holdingId: "a_cash", tier: "cash", valueMinor: 200 }),
      row({
        dateKey: "2026-06-02",
        holdingId: "a_house",
        tier: "illiquid",
        valueMinor: 999,
      }),
    ];

    const state = buildLiquidDrilldown({ currentHoldingIds: ["a_cash"], housingHoldingIds: [], rows });

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
      row({
        dateKey: "2026-06-10",
        holdingId: "a_fund",
        tier: "market",
        valueMinor: 200,
      }),
    ];

    const state = buildLiquidDrilldown({ currentHoldingIds: ["a_cash", "a_fund"], housingHoldingIds: [], rows });

    expect(state.stack).toBeNull();
    expect(state.holdings).toEqual([]);
  });

  test("stacks cash and market nets (assets − liabilities per frozen tier)", () => {
    const rows = [
      row({
        dateKey: "2026-06-01",
        holdingId: "a_cash",
        tier: "cash",
        valueMinor: 100_00,
      }),
      row({
        dateKey: "2026-06-01",
        holdingId: "l_margin",
        tier: "cash",
        valueMinor: 40_00,
        kind: "liability",
      }),
      row({
        dateKey: "2026-06-01",
        holdingId: "a_fund",
        tier: "market",
        valueMinor: 100_00,
      }),
      row({
        dateKey: "2026-06-02",
        holdingId: "a_cash",
        tier: "cash",
        valueMinor: 120_00,
      }),
      row({
        dateKey: "2026-06-02",
        holdingId: "l_margin",
        tier: "cash",
        valueMinor: 40_00,
        kind: "liability",
      }),
      row({
        dateKey: "2026-06-02",
        holdingId: "a_fund",
        tier: "market",
        valueMinor: 100_00,
      }),
    ];

    const state = buildLiquidDrilldown({ currentHoldingIds: [], housingHoldingIds: [], rows });

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
      row({
        dateKey: "2026-06-01",
        holdingId: "a_cash",
        tier: "cash",
        valueMinor: 100_00,
      }),
      row({
        dateKey: "2026-06-01",
        holdingId: "a_fund",
        tier: "market",
        valueMinor: 50_00,
      }),
      row({
        dateKey: "2026-06-02",
        holdingId: "a_cash",
        tier: "cash",
        valueMinor: 100_00,
      }),
      row({
        dateKey: "2026-06-02",
        holdingId: "l_margin",
        tier: "market",
        valueMinor: 70_00,
        kind: "liability",
      }),
      row({
        dateKey: "2026-06-02",
        holdingId: "a_fund",
        tier: "market",
        valueMinor: 50_00,
      }),
    ];

    const state = buildLiquidDrilldown({ currentHoldingIds: [], housingHoldingIds: [], rows });

    expect(state.stack).not.toBeNull();
    expect(state.stack!.mode).toBe("lines");
    for (const band of state.stack!.bands) {
      expect(band.areaPoints).toBeNull();
      expect(band.linePoints.length).toBeGreaterThan(0);
    }
  });

  test("a tier with no rows still gets a band with zero values", () => {
    const rows = [
      row({
        dateKey: "2026-06-01",
        holdingId: "a_cash",
        tier: "cash",
        valueMinor: 100_00,
      }),
      row({
        dateKey: "2026-06-02",
        holdingId: "a_cash",
        tier: "cash",
        valueMinor: 200_00,
      }),
    ];

    const state = buildLiquidDrilldown({ currentHoldingIds: [], housingHoldingIds: [], rows });

    expect(state.stack!.bands.map((b) => b.band)).toEqual(["cash", "market"]);
    expect(state.stack!.mode).toBe("stacked");
  });
});

describe("buildLiquidDrilldown — per-holding small multiples", () => {
  test("one entry per holding with ≥2 captured points; single-point holdings are excluded", () => {
    const rows = [
      row({
        dateKey: "2026-06-01",
        holdingId: "a_cash",
        tier: "cash",
        valueMinor: 100,
        label: "Cuenta",
      }),
      row({
        dateKey: "2026-06-02",
        holdingId: "a_cash",
        tier: "cash",
        valueMinor: 200,
        label: "Cuenta",
      }),
      row({
        dateKey: "2026-06-02",
        holdingId: "a_fund",
        tier: "market",
        valueMinor: 500,
        label: "Fondo",
      }),
    ];

    const state = buildLiquidDrilldown({ currentHoldingIds: ["a_cash", "a_fund"], housingHoldingIds: [], rows });

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

    const state = buildLiquidDrilldown({ currentHoldingIds: ["a_cash"], housingHoldingIds: [], rows });

    const sparkline = state.holdings[0]!.sparkline;
    expect(sparkline.width).toBe(DRILL_SPARKLINE_WIDTH);
    expect(sparkline.height).toBe(DRILL_SPARKLINE_HEIGHT);
    // xs: inset → width − inset. ys: padded domain [90, 210] over height 36.
    const inset = DRILL_SPARKLINE_INSET_X;
    expect(sparkline.linePoints).toBe(`${inset},33 ${DRILL_SPARKLINE_WIDTH - inset},3`);
  });

  test("current value comes from the latest capture when the holding is still held", () => {
    const rows = [
      row({ dateKey: "2026-06-01", holdingId: "a_cash", tier: "cash", valueMinor: 100 }),
      row({ dateKey: "2026-06-02", holdingId: "a_cash", tier: "cash", valueMinor: 250 }),
    ];

    const state = buildLiquidDrilldown({ currentHoldingIds: ["a_cash"], housingHoldingIds: [], rows });

    expect(state.holdings[0]!.currentValueMinor).toBe(250);
  });

  test("a holding no longer in the portfolio has no current value", () => {
    const rows = [
      row({
        dateKey: "2026-06-01",
        holdingId: "a_sold",
        tier: "market",
        valueMinor: 100,
      }),
      row({
        dateKey: "2026-06-02",
        holdingId: "a_sold",
        tier: "market",
        valueMinor: 120,
      }),
    ];

    const state = buildLiquidDrilldown({ currentHoldingIds: [], housingHoldingIds: [], rows });

    expect(state.holdings[0]!.currentValueMinor).toBeNull();
  });

  test("frozen label and tier come from the latest capture of the holding", () => {
    const rows = [
      row({
        dateKey: "2026-06-01",
        holdingId: "a_x",
        tier: "cash",
        valueMinor: 100,
        label: "Vieja",
      }),
      row({
        dateKey: "2026-06-02",
        holdingId: "a_x",
        tier: "market",
        valueMinor: 120,
        label: "Nueva",
      }),
    ];

    const state = buildLiquidDrilldown({ currentHoldingIds: ["a_x"], housingHoldingIds: [], rows });

    expect(state.holdings[0]!.label).toBe("Nueva");
    expect(state.holdings[0]!.tier).toBe("market");
  });

  test("a held holding is not flagged and keeps its current value", () => {
    const rows = [
      row({ dateKey: "2026-06-01", holdingId: "a_cash", tier: "cash", valueMinor: 100 }),
      row({ dateKey: "2026-06-02", holdingId: "a_cash", tier: "cash", valueMinor: 250 }),
    ];

    const state = buildLiquidDrilldown({ currentHoldingIds: ["a_cash"], housingHoldingIds: [], rows });

    expect(state.holdings[0]!.noLongerHeld).toBe(false);
    expect(state.holdings[0]!.currentValueMinor).toBe(250);
  });

  test("holdings are ordered by label for a stable presentation", () => {
    const rows = [
      row({
        dateKey: "2026-06-01",
        holdingId: "a_z",
        tier: "market",
        valueMinor: 1,
        label: "Zeta",
      }),
      row({
        dateKey: "2026-06-02",
        holdingId: "a_z",
        tier: "market",
        valueMinor: 2,
        label: "Zeta",
      }),
      row({
        dateKey: "2026-06-01",
        holdingId: "a_a",
        tier: "cash",
        valueMinor: 1,
        label: "Alfa",
      }),
      row({
        dateKey: "2026-06-02",
        holdingId: "a_a",
        tier: "cash",
        valueMinor: 2,
        label: "Alfa",
      }),
    ];

    const state = buildLiquidDrilldown({ currentHoldingIds: [], housingHoldingIds: [], rows });

    expect(state.holdings.map((h) => h.label)).toEqual(["Alfa", "Zeta"]);
  });
});

describe("buildRestDrilldown — group resolution (#77)", () => {
  test("only retirement and illiquid rows participate; other tiers are excluded", () => {
    const rows = [
      row({
        dateKey: "2026-06-01",
        holdingId: "a_pension",
        tier: "term-locked",
        valueMinor: 100,
      }),
      row({
        dateKey: "2026-06-01",
        holdingId: "a_art",
        tier: "illiquid",
        valueMinor: 50,
      }),
      row({ dateKey: "2026-06-01", holdingId: "a_cash", tier: "cash", valueMinor: 999 }),
      row({
        dateKey: "2026-06-01",
        holdingId: "a_house",
        tier: "illiquid",
        valueMinor: 999,
      }),
      row({
        dateKey: "2026-06-01",
        holdingId: "l_loan",
        tier: null,
        valueMinor: 999,
        kind: "liability",
      }),
      row({
        dateKey: "2026-06-02",
        holdingId: "a_pension",
        tier: "term-locked",
        valueMinor: 120,
      }),
      row({
        dateKey: "2026-06-02",
        holdingId: "a_art",
        tier: "illiquid",
        valueMinor: 50,
      }),
      row({ dateKey: "2026-06-02", holdingId: "a_cash", tier: "cash", valueMinor: 999 }),
    ];

    const state = buildRestDrilldown({
      currentHoldingIds: ["a_pension", "a_art"],
      housingHoldingIds: ["a_house"],
      rows,
    });

    expect(state.key).toBe("rest");
    expect(state.stack).not.toBeNull();
    expect(state.stack!.bands.map((b) => b.band)).toEqual(["term-locked", "illiquid"]);
    expect(state.holdings.map((h) => h.holdingId)).toEqual(["a_art", "a_pension"]);
  });

  test("stacks retirement and illiquid nets with the deterministic stack→lines fallback", () => {
    const rows = [
      row({
        dateKey: "2026-06-01",
        holdingId: "a_pension",
        tier: "term-locked",
        valueMinor: 100_00,
      }),
      row({
        dateKey: "2026-06-01",
        holdingId: "a_art",
        tier: "illiquid",
        valueMinor: 50_00,
      }),
      row({
        dateKey: "2026-06-02",
        holdingId: "a_pension",
        tier: "term-locked",
        valueMinor: 110_00,
      }),
      row({
        dateKey: "2026-06-02",
        holdingId: "l_art_loan",
        tier: "illiquid",
        valueMinor: 70_00,
        kind: "liability",
      }),
      row({
        dateKey: "2026-06-02",
        holdingId: "a_art",
        tier: "illiquid",
        valueMinor: 50_00,
      }),
    ];

    // Illiquid net dips below zero on day 2 → the whole window becomes lines.
    const state = buildRestDrilldown({ currentHoldingIds: [], housingHoldingIds: [], rows });

    expect(state.stack).not.toBeNull();
    expect(state.stack!.mode).toBe("lines");
    for (const band of state.stack!.bands) {
      expect(band.areaPoints).toBeNull();
    }
  });

  test("returns null stack below the two-point placeholder threshold", () => {
    const rows = [
      row({
        dateKey: "2026-06-10",
        holdingId: "a_pension",
        tier: "term-locked",
        valueMinor: 100,
      }),
    ];

    const state = buildRestDrilldown({ currentHoldingIds: ["a_pension"], housingHoldingIds: [], rows });

    expect(state.stack).toBeNull();
    expect(state.holdings).toEqual([]);
  });
});

describe("buildHousingDrilldown — single-tier group (#77)", () => {
  test("only housing rows participate and the key is housing", () => {
    const rows = [
      row({
        dateKey: "2026-06-01",
        holdingId: "a_piso",
        tier: "illiquid",
        valueMinor: 300_000_00,
        label: "Piso",
      }),
      row({ dateKey: "2026-06-01", holdingId: "a_cash", tier: "cash", valueMinor: 999 }),
      row({
        dateKey: "2026-06-01",
        holdingId: "a_pension",
        tier: "term-locked",
        valueMinor: 999,
      }),
      row({
        dateKey: "2026-06-02",
        holdingId: "a_piso",
        tier: "illiquid",
        valueMinor: 320_000_00,
        label: "Piso",
      }),
    ];

    const state = buildHousingDrilldown({
      currentHoldingIds: ["a_piso"],
      housingHoldingIds: ["a_piso"],
      rows,
    });

    expect(state.key).toBe("housing");
    expect(state.holdings.map((h) => h.holdingId)).toEqual(["a_piso"]);
  });

  test("never builds a stack, even with multi-day data", () => {
    const rows = [
      row({
        dateKey: "2026-06-01",
        holdingId: "a_piso",
        tier: "illiquid",
        valueMinor: 300_000_00,
      }),
      row({
        dateKey: "2026-06-02",
        holdingId: "a_piso",
        tier: "illiquid",
        valueMinor: 320_000_00,
      }),
    ];

    const state = buildHousingDrilldown({
      currentHoldingIds: ["a_piso"],
      housingHoldingIds: ["a_piso"],
      rows,
    });

    expect(state.stack).toBeNull();
  });

  test("per-property small multiples answer which property revalued more", () => {
    const rows = [
      row({
        dateKey: "2026-06-01",
        holdingId: "a_piso",
        tier: "illiquid",
        valueMinor: 300_000_00,
        label: "Piso",
      }),
      row({
        dateKey: "2026-06-01",
        holdingId: "a_atico",
        tier: "illiquid",
        valueMinor: 200_000_00,
        label: "Ático",
      }),
      row({
        dateKey: "2026-06-02",
        holdingId: "a_piso",
        tier: "illiquid",
        valueMinor: 320_000_00,
        label: "Piso",
      }),
      row({
        dateKey: "2026-06-02",
        holdingId: "a_atico",
        tier: "illiquid",
        valueMinor: 200_000_00,
        label: "Ático",
      }),
    ];

    const state = buildHousingDrilldown({
      currentHoldingIds: ["a_piso", "a_atico"],
      housingHoldingIds: ["a_piso", "a_atico"],
      rows,
    });

    expect(state.holdings.map((h) => h.label)).toEqual(["Ático", "Piso"]);
    expect(state.holdings.map((h) => h.currentValueMinor)).toEqual([
      200_000_00, 320_000_00,
    ]);
    for (const holding of state.holdings) {
      expect(holding.tier).toBe("illiquid");
      expect(holding.sparkline.linePoints.length).toBeGreaterThan(0);
    }
  });
});

describe("buildLiquidDrilldown — no-longer-held holdings (#78)", () => {
  test("a holding sold mid-window stays in the grid, flagged, with its series truncated at its last capture", () => {
    const rows = [
      // Held holding spans the whole window: 2026-06-01 → 2026-06-05.
      row({
        dateKey: "2026-06-01",
        holdingId: "a_cash",
        tier: "cash",
        valueMinor: 100,
        label: "Cuenta",
      }),
      row({
        dateKey: "2026-06-05",
        holdingId: "a_cash",
        tier: "cash",
        valueMinor: 200,
        label: "Cuenta",
      }),
      // Sold holding's last capture is mid-window (2026-06-03).
      row({
        dateKey: "2026-06-01",
        holdingId: "a_sold",
        tier: "market",
        valueMinor: 100,
        label: "Vendida",
      }),
      row({
        dateKey: "2026-06-03",
        holdingId: "a_sold",
        tier: "market",
        valueMinor: 200,
        label: "Vendida",
      }),
    ];

    const state = buildLiquidDrilldown({ currentHoldingIds: ["a_cash"], housingHoldingIds: [], rows });

    const sold = state.holdings.find((h) => h.holdingId === "a_sold")!;
    expect(sold.noLongerHeld).toBe(true);
    expect(sold.currentValueMinor).toBeNull();

    // Sparkline xs live on the window's shared time axis (4-day span over
    // innerWidth 116): the sold series ends at 06-03 → x = 2 + (2/4)·116 = 60,
    // NOT at the right edge. ys: padded domain [90, 210] over height 36.
    const inset = DRILL_SPARKLINE_INSET_X;
    expect(sold.sparkline.linePoints).toBe(`${inset},33 60,3`);

    // The held holding's series does reach the right edge of the axis.
    const held = state.holdings.find((h) => h.holdingId === "a_cash")!;
    expect(held.noLongerHeld).toBe(false);
    expect(held.sparkline.linePoints).toBe(
      `${inset},33 ${DRILL_SPARKLINE_WIDTH - inset},3`,
    );
  });

  test("a no-longer-held holding with fewer than two captured points stays excluded", () => {
    const rows = [
      row({ dateKey: "2026-06-01", holdingId: "a_cash", tier: "cash", valueMinor: 100 }),
      row({ dateKey: "2026-06-05", holdingId: "a_cash", tier: "cash", valueMinor: 200 }),
      row({
        dateKey: "2026-06-02",
        holdingId: "a_sold",
        tier: "market",
        valueMinor: 500,
      }),
    ];

    const state = buildLiquidDrilldown({ currentHoldingIds: ["a_cash"], housingHoldingIds: [], rows });

    expect(state.holdings.map((h) => h.holdingId)).toEqual(["a_cash"]);
  });

  test("currently-held holdings sort before no-longer-held ones, alphabetically within each group", () => {
    const rows = [
      row({
        dateKey: "2026-06-01",
        holdingId: "a_gone_a",
        tier: "market",
        valueMinor: 1,
        label: "Alfa",
      }),
      row({
        dateKey: "2026-06-02",
        holdingId: "a_gone_a",
        tier: "market",
        valueMinor: 2,
        label: "Alfa",
      }),
      row({
        dateKey: "2026-06-01",
        holdingId: "a_held_z",
        tier: "cash",
        valueMinor: 1,
        label: "Zeta",
      }),
      row({
        dateKey: "2026-06-02",
        holdingId: "a_held_z",
        tier: "cash",
        valueMinor: 2,
        label: "Zeta",
      }),
      row({
        dateKey: "2026-06-01",
        holdingId: "a_held_m",
        tier: "cash",
        valueMinor: 1,
        label: "Media",
      }),
      row({
        dateKey: "2026-06-02",
        holdingId: "a_held_m",
        tier: "cash",
        valueMinor: 2,
        label: "Media",
      }),
      row({
        dateKey: "2026-06-01",
        holdingId: "a_gone_b",
        tier: "market",
        valueMinor: 1,
        label: "Beta",
      }),
      row({
        dateKey: "2026-06-02",
        holdingId: "a_gone_b",
        tier: "market",
        valueMinor: 2,
        label: "Beta",
      }),
    ];

    const state = buildLiquidDrilldown({
      currentHoldingIds: ["a_held_z", "a_held_m"],
      housingHoldingIds: [],
      rows,
    });

    expect(state.holdings.map((h) => h.holdingId)).toEqual([
      "a_held_m",
      "a_held_z",
      "a_gone_a",
      "a_gone_b",
    ]);
  });
});

describe("DRILL_GROUP_BY_TIER — tier → drill group mapping (#79)", () => {
  test("maps each liquidity tier to its drill group", () => {
    expect(DRILL_GROUP_BY_TIER).toEqual({
      cash: "liquid",
      market: "liquid",
      "term-locked": "rest",
      illiquid: "rest",
    });
  });

  test("is consistent with the group tier constants", () => {
    const tiersByGroup = {
      liquid: LIQUID_DRILL_TIERS,
      rest: REST_DRILL_TIERS,
    } as const;

    for (const [tier, group] of Object.entries(DRILL_GROUP_BY_TIER)) {
      // No liquidity rung maps to the housing drill — housing is sourced by id,
      // not by tier (ADR 0013 bridge), so every mapped group is a tier group.
      expect(group).not.toBe("housing");
      expect(tiersByGroup[group as "liquid" | "rest"]).toContain(tier);
    }
  });
});

describe("buildDebtsDrilldown — aggregate debts series + per-debt multiples (#145)", () => {
  const rows = [
    // A secured mortgage (rung illiquid) and an UNSECURED card (null rung).
    row({ dateKey: "2026-04-30", holdingId: "l_mortgage", kind: "liability", label: "Hipoteca", tier: "illiquid", valueMinor: 200_000_00 }),
    row({ dateKey: "2026-05-31", holdingId: "l_mortgage", kind: "liability", label: "Hipoteca", tier: "illiquid", valueMinor: 190_000_00 }),
    row({ dateKey: "2026-06-30", holdingId: "l_mortgage", kind: "liability", label: "Hipoteca", tier: "illiquid", valueMinor: 180_000_00 }),
    row({ dateKey: "2026-04-30", holdingId: "l_card", kind: "liability", label: "Tarjeta", tier: null, valueMinor: 1_000_00 }),
    row({ dateKey: "2026-05-31", holdingId: "l_card", kind: "liability", label: "Tarjeta", tier: null, valueMinor: 1_500_00 }),
    // An asset must never enter the debts drill.
    row({ dateKey: "2026-04-30", holdingId: "a_cash", tier: "cash", valueMinor: 50_000_00 }),
    row({ dateKey: "2026-05-31", holdingId: "a_cash", tier: "cash", valueMinor: 60_000_00 }),
  ];

  test("aggregates every liability (secured AND unsecured) into one 'debts' series", () => {
    const state = buildDebtsDrilldown({
      currentHoldingIds: ["l_mortgage", "l_card"],
      housingHoldingIds: [],
      rows,
    });

    expect(state.key).toBe("debts");
    expect(state.stack).not.toBeNull();
    // A single aggregated band — the main series never splits debt per-liability.
    expect(state.stack!.bands.map((b) => b.band)).toEqual(["debts"]);
    expect(state.stack!.bands).toHaveLength(1);
    // Peak total at the first capture = mortgage 200k + card 1k, summed across
    // BOTH debts (the unsecured card is included). yMax = peak + 10% padding.
    expect(state.stack!.yMax).toBeCloseTo(201_000_00 * 1.1, 0);
  });

  test("lists each contributing debt as a multiple; assets are excluded", () => {
    const state = buildDebtsDrilldown({
      currentHoldingIds: ["l_mortgage", "l_card"],
      housingHoldingIds: [],
      rows,
    });

    // Both held → ordered by frozen label: "Hipoteca" before "Tarjeta".
    expect(state.holdings.map((h) => h.holdingId)).toEqual(["l_mortgage", "l_card"]);
    expect(state.holdings.every((h) => h.kind === "liability")).toBe(true);
    expect(state.holdings.find((h) => h.holdingId === "l_mortgage")!.currentValueMinor).toBe(
      180_000_00,
    );
  });

  test("a debt no longer live stays, flagged and ordered after the live ones (#78)", () => {
    // l_card has left the portfolio but keeps its captured history.
    const state = buildDebtsDrilldown({
      currentHoldingIds: ["l_mortgage"],
      housingHoldingIds: [],
      rows,
    });

    const card = state.holdings.find((h) => h.holdingId === "l_card")!;
    expect(card.noLongerHeld).toBe(true);
    expect(card.currentValueMinor).toBeNull();
    // Live debts first, then no-longer-held.
    expect(state.holdings.map((h) => h.holdingId)).toEqual(["l_mortgage", "l_card"]);
  });

  test("buildDrilldown dispatches the 'debts' key", () => {
    const state = buildDrilldown("debts", {
      currentHoldingIds: ["l_mortgage", "l_card"],
      housingHoldingIds: [],
      rows,
    });

    expect(state.key).toBe("debts");
  });
});
