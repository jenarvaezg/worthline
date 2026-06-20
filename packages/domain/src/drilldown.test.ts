/**
 * Tests for the drilldown state module (#76).
 *
 * buildLiquidDrilldown: snapshot holding rows + current portfolio → drill view
 * state for the liquid group (cash + market tiers):
 * - per-tier stacked series over time (net = assets − liabilities per frozen
 *   tier), drawn as per-period BARS (plus areaPoints + a total line) in stacked
 *   mode, with the deterministic stack→lines fallback and the <2 points rule
 * - per-holding bar-sparkline entries for currently-held holdings with ≥2
 *   captured points, carrying the frozen label and the current value
 * - the retired rule (this design pass): a holding no longer in the portfolio
 *   is DROPPED from the cards entirely; its history still lives in the aggregate
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
  DRILL_SPARKLINE_MIN_BAR_HEIGHT,
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
  countsAsHousing?: boolean;
  securesHousing?: boolean;
}): DatedSnapshotHoldingRow {
  return {
    countsAsHousing: input.countsAsHousing ?? false,
    dateKey: input.dateKey,
    holdingId: input.holdingId,
    kind: input.kind ?? "asset",
    label: input.label ?? input.holdingId,
    liquidityTier: input.tier,
    securesHousing: input.securesHousing ?? false,
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

    const state = buildLiquidDrilldown({
      currentHoldingIds: ["a_cash"],
      rows,
    });

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

    const state = buildLiquidDrilldown({
      currentHoldingIds: ["a_cash", "a_fund"],
      rows,
    });

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

    const state = buildLiquidDrilldown({
      currentHoldingIds: [],
      rows,
    });

    expect(state.stack).not.toBeNull();
    expect(state.stack!.mode).toBe("stacked");
    // Stacked domain includes the zero baseline; top edge is the group net:
    // day 1 → cash 60 + market 100 = 160, day 2 → 80 + 100 = 180.
    // Padded by 10% of the [0, 180] range.
    expect(state.stack!.yMin).toBe(-18_00);
    expect(state.stack!.yMax).toBe(198_00);
    // Stacked mode now also emits per-period BARS and a stack-total line
    // (this design pass), one rect per date key per band.
    expect(state.stack!.totalLine).not.toBeNull();
    for (const band of state.stack!.bands) {
      expect(band.areaPoints).not.toBeNull();
      expect(band.bars).not.toBeNull();
      expect(band.bars).toHaveLength(2);
      for (const bar of band.bars!) {
        expect(bar.height).toBeGreaterThanOrEqual(0);
        expect(bar.width).toBeGreaterThan(0);
      }
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

    const state = buildLiquidDrilldown({
      currentHoldingIds: [],
      rows,
    });

    expect(state.stack).not.toBeNull();
    expect(state.stack!.mode).toBe("lines");
    // Lines mode draws neither bars nor a total line — only the per-band lines.
    expect(state.stack!.totalLine).toBeNull();
    for (const band of state.stack!.bands) {
      expect(band.areaPoints).toBeNull();
      expect(band.bars).toBeNull();
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

    const state = buildLiquidDrilldown({
      currentHoldingIds: [],
      rows,
    });

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

    const state = buildLiquidDrilldown({
      currentHoldingIds: ["a_cash", "a_fund"],
      rows,
    });

    expect(state.holdings).toHaveLength(1);
    expect(state.holdings[0]).toMatchObject({
      holdingId: "a_cash",
      kind: "asset",
      label: "Cuenta",
      tier: "cash",
    });
  });

  test("sparkline emits one evenly-spaced bar per capture, floored from a zero baseline", () => {
    const rows = [
      row({ dateKey: "2026-06-01", holdingId: "a_cash", tier: "cash", valueMinor: 100 }),
      row({ dateKey: "2026-06-02", holdingId: "a_cash", tier: "cash", valueMinor: 200 }),
    ];

    const state = buildLiquidDrilldown({
      currentHoldingIds: ["a_cash"],
      rows,
    });

    const sparkline = state.holdings[0]!.sparkline;
    expect(sparkline.width).toBe(DRILL_SPARKLINE_WIDTH);
    expect(sparkline.height).toBe(DRILL_SPARKLINE_HEIGHT);
    // Two captures → two evenly-spaced bars. slot = 120/2 = 60, barWidth =
    // 60·0.7 = 42. Heights scale against the peak (200) from a zero floor:
    // 100 → 18, 200 → 36 (full height). y = height − barHeight.
    expect(sparkline.bars).toEqual([
      { height: 18, width: 42, x: 9, y: 18 },
      { height: 36, width: 42, x: 69, y: 0 },
    ]);
  });

  test("a flat (or sparse) sparkline floors each bar at the minimum height", () => {
    const rows = [
      row({ dateKey: "2026-06-01", holdingId: "a_cash", tier: "cash", valueMinor: 0 }),
      row({ dateKey: "2026-06-02", holdingId: "a_cash", tier: "cash", valueMinor: 100 }),
    ];

    const state = buildLiquidDrilldown({
      currentHoldingIds: ["a_cash"],
      rows,
    });

    const sparkline = state.holdings[0]!.sparkline;
    // The zero-valued capture is floored so it still reads as a discrete tick.
    expect(sparkline.bars[0]!.height).toBe(DRILL_SPARKLINE_MIN_BAR_HEIGHT);
    expect(sparkline.bars[1]!.height).toBe(DRILL_SPARKLINE_HEIGHT);
  });

  test("current value comes from the latest capture when the holding is still held", () => {
    const rows = [
      row({ dateKey: "2026-06-01", holdingId: "a_cash", tier: "cash", valueMinor: 100 }),
      row({ dateKey: "2026-06-02", holdingId: "a_cash", tier: "cash", valueMinor: 250 }),
    ];

    const state = buildLiquidDrilldown({
      currentHoldingIds: ["a_cash"],
      rows,
    });

    expect(state.holdings[0]!.currentValueMinor).toBe(250);
  });

  test("a holding no longer in the portfolio is dropped from the cards entirely", () => {
    const rows = [
      row({ dateKey: "2026-06-01", holdingId: "a_cash", tier: "cash", valueMinor: 50 }),
      row({ dateKey: "2026-06-02", holdingId: "a_cash", tier: "cash", valueMinor: 70 }),
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

    const state = buildLiquidDrilldown({
      currentHoldingIds: ["a_cash"],
      rows,
    });

    // The retired holding never reaches the per-holding grid…
    expect(state.holdings.map((h) => h.holdingId)).toEqual(["a_cash"]);
    // …yet its past value still lives in the AGGREGATE stack history: the
    // day-1 market net (120 from a_sold) and day-2 market net (120) are both
    // present, so the aggregate is unchanged by the card drop.
    const market = state.stack!.bands.find((b) => b.band === "market")!;
    expect(market.bars).not.toBeNull();
    expect(market.bars).toHaveLength(2);
    expect(market.bars!.every((bar) => bar.height > 0)).toBe(true);
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

    const state = buildLiquidDrilldown({
      currentHoldingIds: ["a_x"],
      rows,
    });

    expect(state.holdings[0]!.label).toBe("Nueva");
    expect(state.holdings[0]!.tier).toBe("market");
  });

  test("a held holding keeps its current value", () => {
    const rows = [
      row({ dateKey: "2026-06-01", holdingId: "a_cash", tier: "cash", valueMinor: 100 }),
      row({ dateKey: "2026-06-02", holdingId: "a_cash", tier: "cash", valueMinor: 250 }),
    ];

    const state = buildLiquidDrilldown({
      currentHoldingIds: ["a_cash"],
      rows,
    });

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

    const state = buildLiquidDrilldown({
      currentHoldingIds: ["a_z", "a_a"],
      rows,
    });

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
        tier: "housing",
        valueMinor: 999,
        countsAsHousing: true,
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
      rows,
    });

    expect(state.key).toBe("rest");
    expect(state.stack).not.toBeNull();
    expect(state.stack!.bands.map((b) => b.band)).toEqual(["term-locked", "illiquid"]);
    // The house sits on the housing rung, never in rest — no double-count.
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
    const state = buildRestDrilldown({
      currentHoldingIds: [],
      rows,
    });

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

    const state = buildRestDrilldown({
      currentHoldingIds: ["a_pension"],
      rows,
    });

    expect(state.stack).toBeNull();
    expect(state.holdings).toEqual([]);
  });
});

describe("buildHousingDrilldown — single-tier group (#77, ADR 0022)", () => {
  test("only housing-rung rows participate and the key is housing", () => {
    const rows = [
      row({
        dateKey: "2026-06-01",
        holdingId: "a_piso",
        tier: "housing",
        valueMinor: 300_000_00,
        label: "Piso",
        countsAsHousing: true,
      }),
      row({ dateKey: "2026-06-01", holdingId: "a_cash", tier: "cash", valueMinor: 999 }),
      row({
        dateKey: "2026-06-01",
        holdingId: "a_pension",
        tier: "term-locked",
        valueMinor: 999,
      }),
      // A non-housing illiquid holding (art) must NOT be selected into housing.
      row({ dateKey: "2026-06-01", holdingId: "a_art", tier: "illiquid", valueMinor: 1 }),
      row({
        dateKey: "2026-06-02",
        holdingId: "a_piso",
        tier: "housing",
        valueMinor: 320_000_00,
        label: "Piso",
        countsAsHousing: true,
      }),
    ];

    const state = buildHousingDrilldown({
      currentHoldingIds: ["a_piso"],
      rows,
    });

    expect(state.key).toBe("housing");
    expect(state.holdings.map((h) => h.holdingId)).toEqual(["a_piso"]);
  });

  test("defensive: a pre-migration property frozen on illiquid but countsAsHousing is still selected", () => {
    const rows = [
      row({
        dateKey: "2026-06-01",
        holdingId: "a_piso",
        tier: "illiquid",
        valueMinor: 300_000_00,
        label: "Piso",
        countsAsHousing: true,
      }),
      row({ dateKey: "2026-06-01", holdingId: "a_art", tier: "illiquid", valueMinor: 1 }),
      row({
        dateKey: "2026-06-02",
        holdingId: "a_piso",
        tier: "illiquid",
        valueMinor: 320_000_00,
        label: "Piso",
        countsAsHousing: true,
      }),
    ];

    const state = buildHousingDrilldown({
      currentHoldingIds: ["a_piso"],
      rows,
    });

    expect(state.holdings.map((h) => h.holdingId)).toEqual(["a_piso"]);
  });

  test("defensive: a pre-migration mortgage (frozen illiquid, securesHousing=true) lands in housing drill alongside its house", () => {
    // Legacy capture: v28 migration had not run yet, so both rows are frozen with
    // liquidityTier='illiquid'. The house carries countsAsHousing=true; the mortgage
    // carries securesHousing=true. effectiveRung must resolve both to "housing" so the
    // housing drill nets house − mortgage, and neither appears in rest.
    const rows = [
      row({
        dateKey: "2026-06-01",
        holdingId: "a_piso",
        tier: "illiquid",
        valueMinor: 300_000_00,
        label: "Piso",
        countsAsHousing: true,
      }),
      row({
        dateKey: "2026-06-01",
        holdingId: "l_hipoteca",
        tier: "illiquid",
        valueMinor: -200_000_00,
        kind: "liability",
        label: "Hipoteca",
        securesHousing: true,
      }),
      row({
        dateKey: "2026-06-01",
        holdingId: "a_art",
        tier: "illiquid",
        valueMinor: 5_000_00,
        label: "Arte",
      }),
      // Second capture so each holding has ≥2 rows and passes the sparkline guard
      row({
        dateKey: "2026-06-02",
        holdingId: "a_piso",
        tier: "illiquid",
        valueMinor: 305_000_00,
        label: "Piso",
        countsAsHousing: true,
      }),
      row({
        dateKey: "2026-06-02",
        holdingId: "l_hipoteca",
        tier: "illiquid",
        valueMinor: -199_000_00,
        kind: "liability",
        label: "Hipoteca",
        securesHousing: true,
      }),
      row({
        dateKey: "2026-06-02",
        holdingId: "a_art",
        tier: "illiquid",
        valueMinor: 5_100_00,
        label: "Arte",
      }),
    ];

    const housingState = buildHousingDrilldown({
      currentHoldingIds: ["a_piso", "l_hipoteca"],
      rows,
    });
    const restState = buildRestDrilldown({
      currentHoldingIds: ["a_piso", "a_art"],
      rows,
    });

    // Both house and mortgage land in housing drill
    expect(housingState.holdings.map((h) => h.holdingId).sort()).toEqual(
      ["a_piso", "l_hipoteca"].sort(),
    );
    // Mortgage does NOT appear in rest
    expect(restState.holdings.map((h) => h.holdingId)).not.toContain("l_hipoteca");
    // Only art in rest
    expect(restState.holdings.map((h) => h.holdingId)).toContain("a_art");
  });

  test("never builds a stack, even with multi-day data", () => {
    const rows = [
      row({
        dateKey: "2026-06-01",
        holdingId: "a_piso",
        tier: "housing",
        valueMinor: 300_000_00,
        countsAsHousing: true,
      }),
      row({
        dateKey: "2026-06-02",
        holdingId: "a_piso",
        tier: "housing",
        valueMinor: 320_000_00,
        countsAsHousing: true,
      }),
    ];

    const state = buildHousingDrilldown({
      currentHoldingIds: ["a_piso"],
      rows,
    });

    expect(state.stack).toBeNull();
  });

  test("per-property small multiples answer which property revalued more", () => {
    const rows = [
      row({
        dateKey: "2026-06-01",
        holdingId: "a_piso",
        tier: "housing",
        valueMinor: 300_000_00,
        label: "Piso",
        countsAsHousing: true,
      }),
      row({
        dateKey: "2026-06-01",
        holdingId: "a_atico",
        tier: "housing",
        valueMinor: 200_000_00,
        label: "Ático",
        countsAsHousing: true,
      }),
      row({
        dateKey: "2026-06-02",
        holdingId: "a_piso",
        tier: "housing",
        valueMinor: 320_000_00,
        label: "Piso",
        countsAsHousing: true,
      }),
      row({
        dateKey: "2026-06-02",
        holdingId: "a_atico",
        tier: "housing",
        valueMinor: 200_000_00,
        label: "Ático",
        countsAsHousing: true,
      }),
    ];

    const state = buildHousingDrilldown({
      currentHoldingIds: ["a_piso", "a_atico"],
      rows,
    });

    expect(state.holdings.map((h) => h.label)).toEqual(["Ático", "Piso"]);
    expect(state.holdings.map((h) => h.currentValueMinor)).toEqual([
      200_000_00, 320_000_00,
    ]);
    for (const holding of state.holdings) {
      expect(holding.tier).toBe("housing");
      expect(holding.sparkline.bars.length).toBeGreaterThan(0);
    }
  });
});

describe("buildLiquidDrilldown — retired holdings dropped from cards (this design pass)", () => {
  test("a holding sold mid-window is absent from the cards, but its history stays in the aggregate", () => {
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

    const state = buildLiquidDrilldown({
      currentHoldingIds: ["a_cash"],
      rows,
    });

    // The sold holding is gone from the cards; only the held one remains.
    expect(state.holdings.map((h) => h.holdingId)).toEqual(["a_cash"]);
    const held = state.holdings.find((h) => h.holdingId === "a_cash")!;
    expect(held.currentValueMinor).toBe(200);
    expect(held.sparkline.bars.length).toBeGreaterThan(0);

    // Its past value still rides in the AGGREGATE market band: the 06-01 and
    // 06-03 market nets (100, 200) are preserved as bars in the stack history.
    const market = state.stack!.bands.find((b) => b.band === "market")!;
    expect(market.bars).not.toBeNull();
    expect(market.bars!.some((bar) => bar.height > 0)).toBe(true);
  });

  test("a retired holding with fewer than two captured points stays excluded too", () => {
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

    const state = buildLiquidDrilldown({
      currentHoldingIds: ["a_cash"],
      rows,
    });

    expect(state.holdings.map((h) => h.holdingId)).toEqual(["a_cash"]);
  });

  test("only currently-held holdings appear, ordered alphabetically by label", () => {
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
      rows,
    });

    // The retired Alfa/Beta cards are dropped; only the two held ones remain,
    // ordered by label.
    expect(state.holdings.map((h) => h.holdingId)).toEqual(["a_held_m", "a_held_z"]);
  });
});

describe("DRILL_GROUP_BY_TIER — tier → drill group mapping (#79)", () => {
  test("maps each liquidity tier to its drill group", () => {
    expect(DRILL_GROUP_BY_TIER).toEqual({
      cash: "liquid",
      market: "liquid",
      "term-locked": "rest",
      illiquid: "rest",
      housing: "housing",
    });
  });

  test("is consistent with the group tier constants (housing is its own single-rung group)", () => {
    const tiersByGroup = {
      liquid: LIQUID_DRILL_TIERS,
      rest: REST_DRILL_TIERS,
    } as const;

    for (const [tier, group] of Object.entries(DRILL_GROUP_BY_TIER)) {
      // The housing rung maps to the housing drill (ADR 0022) — a single-rung
      // group with no stack constant; every other rung is a tier group.
      if (group === "housing") {
        expect(tier).toBe("housing");
        continue;
      }
      expect(tiersByGroup[group as "liquid" | "rest"]).toContain(tier);
    }
  });
});

describe("buildDebtsDrilldown — aggregate debts series + per-debt multiples (#145)", () => {
  const rows = [
    // A secured mortgage (rung illiquid) and an UNSECURED card (null rung).
    row({
      dateKey: "2026-04-30",
      holdingId: "l_mortgage",
      kind: "liability",
      label: "Hipoteca",
      tier: "illiquid",
      valueMinor: 200_000_00,
    }),
    row({
      dateKey: "2026-05-31",
      holdingId: "l_mortgage",
      kind: "liability",
      label: "Hipoteca",
      tier: "illiquid",
      valueMinor: 190_000_00,
    }),
    row({
      dateKey: "2026-06-30",
      holdingId: "l_mortgage",
      kind: "liability",
      label: "Hipoteca",
      tier: "illiquid",
      valueMinor: 180_000_00,
    }),
    row({
      dateKey: "2026-04-30",
      holdingId: "l_card",
      kind: "liability",
      label: "Tarjeta",
      tier: null,
      valueMinor: 1_000_00,
    }),
    row({
      dateKey: "2026-05-31",
      holdingId: "l_card",
      kind: "liability",
      label: "Tarjeta",
      tier: null,
      valueMinor: 1_500_00,
    }),
    // An asset must never enter the debts drill.
    row({
      dateKey: "2026-04-30",
      holdingId: "a_cash",
      tier: "cash",
      valueMinor: 50_000_00,
    }),
    row({
      dateKey: "2026-05-31",
      holdingId: "a_cash",
      tier: "cash",
      valueMinor: 60_000_00,
    }),
  ];

  test("aggregates every liability (secured AND unsecured) into one 'debts' series", () => {
    const state = buildDebtsDrilldown({
      currentHoldingIds: ["l_mortgage", "l_card"],
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
      rows,
    });

    // Both held → ordered by frozen label: "Hipoteca" before "Tarjeta".
    expect(state.holdings.map((h) => h.holdingId)).toEqual(["l_mortgage", "l_card"]);
    expect(state.holdings.every((h) => h.kind === "liability")).toBe(true);
    expect(
      state.holdings.find((h) => h.holdingId === "l_mortgage")!.currentValueMinor,
    ).toBe(180_000_00);
  });

  test("a debt no longer live is dropped from the cards, but its history stays in the aggregate", () => {
    // l_card has left the portfolio; its card is dropped (this design pass).
    const state = buildDebtsDrilldown({
      currentHoldingIds: ["l_mortgage"],
      rows,
    });

    // Only the live mortgage card remains.
    expect(state.holdings.map((h) => h.holdingId)).toEqual(["l_mortgage"]);
    // Yet the aggregate still reflects the card's history: the peak total
    // includes the card (mortgage 200k + card 1k), unchanged by the card drop.
    expect(state.stack!.yMax).toBeCloseTo(201_000_00 * 1.1, 0);
  });

  test("buildDrilldown dispatches the 'debts' key", () => {
    const state = buildDrilldown("debts", {
      currentHoldingIds: ["l_mortgage", "l_card"],
      rows,
    });

    expect(state.key).toBe("debts");
  });
});

describe("build*Drilldown — non-live holdings dropped from cards (#268, this design pass)", () => {
  // Three holdings, two of which have left the current portfolio: one was
  // transferred and now sits in the Papelera (soft delete, recoverable), the
  // other was truly retired (hard-deleted / written off). Both are now dropped
  // from the cards (only currently-held holdings appear); their history still
  // lives in the aggregate. Only the live holding gets a card.
  const rows = [
    row({
      dateKey: "2026-06-01",
      holdingId: "a_live",
      tier: "cash",
      valueMinor: 100,
      label: "Viva",
    }),
    row({
      dateKey: "2026-06-03",
      holdingId: "a_live",
      tier: "cash",
      valueMinor: 200,
      label: "Viva",
    }),
    row({
      dateKey: "2026-06-01",
      holdingId: "a_trashed",
      tier: "market",
      valueMinor: 100,
      label: "Traspasada",
    }),
    row({
      dateKey: "2026-06-03",
      holdingId: "a_trashed",
      tier: "market",
      valueMinor: 200,
      label: "Traspasada",
    }),
    row({
      dateKey: "2026-06-01",
      holdingId: "a_gone",
      tier: "market",
      valueMinor: 100,
      label: "Retirada",
    }),
    row({
      dateKey: "2026-06-03",
      holdingId: "a_gone",
      tier: "market",
      valueMinor: 200,
      label: "Retirada",
    }),
  ];

  const state = () =>
    buildLiquidDrilldown({
      currentHoldingIds: ["a_live"],
      trashedHoldingIds: ["a_trashed"],
      rows,
    });

  test("a holding transferred to the Papelera is dropped from the cards entirely", () => {
    expect(state().holdings.map((h) => h.holdingId)).not.toContain("a_trashed");
  });

  test("a truly-retired holding is also dropped — only the live one gets a card", () => {
    const holdings = state().holdings;

    expect(holdings.map((h) => h.holdingId)).toEqual(["a_live"]);
    const live = holdings.find((h) => h.holdingId === "a_live")!;
    expect(live.currentValueMinor).toBe(200);
  });

  test("the dropped holdings' history still lives in the aggregate market band", () => {
    // a_trashed and a_gone are both market-tier; their 06-01/06-03 nets remain
    // in the aggregate stack even though neither gets a card.
    const market = state().stack!.bands.find((b) => b.band === "market")!;
    expect(market.bars).not.toBeNull();
    expect(market.bars!.some((bar) => bar.height > 0)).toBe(true);
  });

  test("without trashedHoldingIds, an absent holding is still dropped from the cards", () => {
    const fallback = buildLiquidDrilldown({
      currentHoldingIds: ["a_live"],
      rows,
    });

    // a_trashed is absent from currentHoldingIds, so it is dropped like any
    // other not-currently-held holding.
    expect(fallback.holdings.map((h) => h.holdingId)).not.toContain("a_trashed");
    expect(fallback.holdings.map((h) => h.holdingId)).toEqual(["a_live"]);
  });
});
