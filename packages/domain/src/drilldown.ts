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
 *
 * Frozen means frozen (#78): a holding that has left the portfolio — sold,
 * written off, deleted, with or without losses — keeps its captured history.
 * Its small multiple stays in the grid, truncated at its last capture on the
 * group window's shared time axis, flagged as no longer held, and ordered
 * after the currently-held holdings.
 */

import type { LiquidityTier } from "./classification";
import {
  buildStackedChartGeometry,
  type StackedChartGeometry,
} from "./decomposition-chart";
import { paddedValueDomain, valueToY } from "./evolution-chart";
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
   * portfolio; `null` when no longer held.
   */
  currentValueMinor: number | null;
  /** True when the holding has left the portfolio (sold, written off, deleted). */
  noLongerHeld: boolean;
}

export interface LiquidDrilldownState {
  key: "liquid";
  /**
   * Per-tier stacked series over time (cash, then market), or `null` below
   * the two-point placeholder threshold.
   */
  stack: StackedChartGeometry<LiquidDrillTier> | null;
  /**
   * Small-multiple entries: currently-held holdings first, no-longer-held
   * ones at the end, each group ordered by label for a stable presentation.
   */
  holdings: DrillHoldingMultiple[];
}

/** A drill group row: a dated holding row whose frozen tier resolved into the group. */
export type DrillGroupRow = DatedSnapshotHoldingRow & { liquidityTier: LiquidityTier };

/** A group row: a dated holding row whose frozen tier belongs to the drill group. */
type LiquidGroupRow = DatedSnapshotHoldingRow & { liquidityTier: LiquidDrillTier };

/** The signed contribution of a row to its tier's net: assets add, liabilities subtract. */
function signedValueMinor(row: DatedSnapshotHoldingRow): number {
  return row.kind === "liability" ? -row.valueMinor : row.valueMinor;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function parseDateKey(dateKey: string): number {
  return Date.parse(`${dateKey}T00:00:00Z`);
}

/**
 * Sparkline geometry for one holding. The xs live on the GROUP WINDOW's
 * shared time axis (not the holding's own span): a series whose last capture
 * predates the window's end simply stops there instead of stretching to the
 * right edge — that truncation is how a no-longer-held holding reads (#78).
 */
function buildSparkline(
  dateKeys: string[],
  valuesMinor: number[],
  windowStartMs: number,
  windowSpanMs: number,
): DrillSparklineGeometry | null {
  const times = dateKeys.map(parseDateKey);

  if (
    !Number.isFinite(windowSpanMs) ||
    windowSpanMs <= 0 ||
    times.some((t) => Number.isNaN(t)) ||
    new Set(dateKeys).size < 2
  ) {
    return null;
  }

  const innerWidth = DRILL_SPARKLINE_WIDTH - 2 * DRILL_SPARKLINE_INSET_X;
  const { yMin, yMax } = paddedValueDomain(valuesMinor);
  const linePoints = times
    .map((t, i) => {
      const x = round2(
        DRILL_SPARKLINE_INSET_X + ((t - windowStartMs) / windowSpanMs) * innerWidth,
      );
      return `${x},${valueToY(valuesMinor[i]!, yMin, yMax, DRILL_SPARKLINE_HEIGHT)}`;
    })
    .join(" ");

  return {
    height: DRILL_SPARKLINE_HEIGHT,
    linePoints,
    width: DRILL_SPARKLINE_WIDTH,
  };
}

/**
 * Builds the per-holding small-multiple entries of a drill group from its
 * frozen rows. Shared by every drill key so all groups inherit the rules:
 * a holding needs ≥2 captured points in the window to appear, but it appears
 * even when it has left the portfolio — its series truncated at its last
 * capture, flagged as no longer held, and ordered after the currently-held
 * holdings (stable by label within each group).
 */
export function buildDrillHoldingMultiples(
  groupRows: readonly DrillGroupRow[],
  currentHoldingIds: readonly string[],
): DrillHoldingMultiple[] {
  const sortedRows = [...groupRows].sort((a, b) => a.dateKey.localeCompare(b.dateKey));

  if (sortedRows.length === 0) return [];

  const windowStartMs = parseDateKey(sortedRows[0]!.dateKey);
  const windowSpanMs = parseDateKey(sortedRows.at(-1)!.dateKey) - windowStartMs;

  const rowsByHolding = new Map<string, DrillGroupRow[]>();

  for (const row of sortedRows) {
    rowsByHolding.set(row.holdingId, [...(rowsByHolding.get(row.holdingId) ?? []), row]);
  }

  const heldIds = new Set(currentHoldingIds);

  return [...rowsByHolding.entries()]
    .flatMap(([holdingId, rows]) => {
      const sparkline = buildSparkline(
        rows.map((row) => row.dateKey),
        rows.map((row) => row.valueMinor),
        windowStartMs,
        windowSpanMs,
      );

      if (rows.length < 2 || !sparkline) return [];

      const latest = rows.at(-1)!;
      const noLongerHeld = !heldIds.has(holdingId);

      return [
        {
          currentValueMinor: noLongerHeld ? null : latest.valueMinor,
          holdingId,
          kind: latest.kind,
          label: latest.label,
          noLongerHeld,
          sparkline,
          tier: latest.liquidityTier,
        } satisfies DrillHoldingMultiple,
      ];
    })
    .sort(
      (a, b) =>
        Number(a.noLongerHeld) - Number(b.noLongerHeld) ||
        a.label.localeCompare(b.label) ||
        a.holdingId.localeCompare(b.holdingId),
    );
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

  // ── Per-holding small multiples: shared rule across drill groups ─────────
  const holdings = buildDrillHoldingMultiples(groupRows, input.currentHoldingIds);

  return { holdings, key: "liquid", stack };
}
