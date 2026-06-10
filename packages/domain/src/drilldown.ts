/**
 * Drilldown state module (#76) — pure domain math behind the server-rendered
 * drill view that replaces the decomposition chart.
 *
 * A drill key resolves a group of liquidity tiers; for this issue only the
 * "liquid" key exists: cash + market. Everything is derived exclusively from
 * frozen snapshot holding rows (per-tier aggregates are never stored, ADR
 * 0008): a per-tier stacked series over time (net per frozen tier = asset
 * rows − liability rows), reusing the decomposition stack geometry with its
 * deterministic stack→lines fallback, plus per-holding sparkline entries for
 * the small-multiples grid. No React, no SVG — just numbers and strings.
 */

import type { LiquidityTier } from "./classification";
import {
  buildStackedChartGeometry,
  type StackedChartGeometry,
} from "./decomposition-chart";
import { paddedValueDomain, timeProportionalXs, valueToY } from "./evolution-chart";
import type { SnapshotHoldingKind, SnapshotHoldingRow } from "./snapshot-holdings";

/** The drill keys the home understands. Only "liquid" exists for now (#77 adds more). */
export type DrilldownKey = "liquid";

/** The liquid group: the tiers that make up liquid net worth. */
export const LIQUID_DRILL_TIERS = ["cash", "market"] as const;

export type LiquidDrillTier = (typeof LIQUID_DRILL_TIERS)[number];

/** A frozen holding row plus the calendar day of its capture. */
export interface DatedSnapshotHoldingRow extends SnapshotHoldingRow {
  /** Calendar day of the capture, YYYY-MM-DD. */
  dateKey: string;
}

export interface LiquidDrilldownInput {
  /** Frozen holding rows of the scope, any tiers — the module filters the group. */
  rows: DatedSnapshotHoldingRow[];
  /** Ids of the holdings currently in the portfolio (assets and liabilities). */
  currentHoldingIds: readonly string[];
}

export const DRILL_SPARKLINE_WIDTH = 120;
export const DRILL_SPARKLINE_HEIGHT = 36;
/** Horizontal inset so the sparkline endpoints are not clipped by the viewBox. */
export const DRILL_SPARKLINE_INSET_X = 2;

export interface DrillSparklineGeometry {
  width: number;
  height: number;
  /** Polyline vertices as an SVG points string: "x,y x,y …". */
  linePoints: string;
}

/** One small-multiple entry: a holding with at least two captured points. */
export interface DrillHoldingMultiple {
  holdingId: string;
  kind: SnapshotHoldingKind;
  /** The holding's label as frozen at its latest capture in the window. */
  label: string;
  /** The holding's tier as frozen at its latest capture in the window. */
  tier: LiquidityTier;
  sparkline: DrillSparklineGeometry;
  /**
   * The holding's latest captured scoped value when it is still in the
   * portfolio; `null` when no longer held (finer presentation of sold
   * holdings is #78).
   */
  currentValueMinor: number | null;
}

export interface LiquidDrilldownState {
  key: "liquid";
  /**
   * Per-tier stacked series over time (cash, then market), or `null` below
   * the two-point placeholder threshold.
   */
  stack: StackedChartGeometry<LiquidDrillTier> | null;
  /** Small-multiple entries, ordered by label for a stable presentation. */
  holdings: DrillHoldingMultiple[];
}

/** A group row: a dated holding row whose frozen tier belongs to the drill group. */
type LiquidGroupRow = DatedSnapshotHoldingRow & { liquidityTier: LiquidDrillTier };

/** The signed contribution of a row to its tier's net: assets add, liabilities subtract. */
function signedValueMinor(row: DatedSnapshotHoldingRow): number {
  return row.kind === "liability" ? -row.valueMinor : row.valueMinor;
}

function buildSparkline(
  dateKeys: string[],
  valuesMinor: number[],
): DrillSparklineGeometry | null {
  const xs = timeProportionalXs(dateKeys, DRILL_SPARKLINE_WIDTH, DRILL_SPARKLINE_INSET_X);
  if (!xs) return null;

  const { yMin, yMax } = paddedValueDomain(valuesMinor);
  const linePoints = xs
    .map(
      (x, i) =>
        `${x},${valueToY(valuesMinor[i]!, yMin, yMax, DRILL_SPARKLINE_HEIGHT)}`,
    )
    .join(" ");

  return {
    height: DRILL_SPARKLINE_HEIGHT,
    linePoints,
    width: DRILL_SPARKLINE_WIDTH,
  };
}

/**
 * Builds the liquid drill view state from frozen snapshot holding rows:
 * the cash-vs-market stacked series and the per-holding small multiples.
 */
export function buildLiquidDrilldown(input: LiquidDrilldownInput): LiquidDrilldownState {
  const tierSet = new Set<LiquidityTier>(LIQUID_DRILL_TIERS);
  const groupRows = input.rows
    .filter(
      (row): row is LiquidGroupRow =>
        row.liquidityTier !== null && tierSet.has(row.liquidityTier),
    )
    .sort((a, b) => a.dateKey.localeCompare(b.dateKey));

  // ── Per-tier stacked series: one point per capture day of the group ──────
  const dateKeys = [...new Set(groupRows.map((row) => row.dateKey))];
  const netByTierByDate = new Map<string, Map<LiquidDrillTier, number>>(
    dateKeys.map((dateKey) => [
      dateKey,
      new Map(LIQUID_DRILL_TIERS.map((tier) => [tier, 0])),
    ]),
  );

  for (const row of groupRows) {
    const tierNets = netByTierByDate.get(row.dateKey)!;
    tierNets.set(row.liquidityTier, tierNets.get(row.liquidityTier)! + signedValueMinor(row));
  }

  const stack = buildStackedChartGeometry<LiquidDrillTier>(
    dateKeys,
    LIQUID_DRILL_TIERS.map((tier) => ({
      band: tier,
      values: dateKeys.map((dateKey) => netByTierByDate.get(dateKey)!.get(tier)!),
    })),
  );

  // ── Per-holding small multiples: holdings with ≥2 captured points ────────
  const rowsByHolding = new Map<string, LiquidGroupRow[]>();

  for (const row of groupRows) {
    rowsByHolding.set(row.holdingId, [...(rowsByHolding.get(row.holdingId) ?? []), row]);
  }

  const heldIds = new Set(input.currentHoldingIds);
  const holdings = [...rowsByHolding.entries()]
    .flatMap(([holdingId, rows]) => {
      const sparkline = buildSparkline(
        rows.map((row) => row.dateKey),
        rows.map((row) => row.valueMinor),
      );

      if (rows.length < 2 || !sparkline) return [];

      const latest = rows.at(-1)!;

      return [
        {
          currentValueMinor: heldIds.has(holdingId) ? latest.valueMinor : null,
          holdingId,
          kind: latest.kind,
          label: latest.label,
          sparkline,
          tier: latest.liquidityTier,
        } satisfies DrillHoldingMultiple,
      ];
    })
    .sort(
      (a, b) => a.label.localeCompare(b.label) || a.holdingId.localeCompare(b.holdingId),
    );

  return { holdings, key: "liquid", stack };
}
