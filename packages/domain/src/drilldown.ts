/**
 * Drilldown state module (#76, #77) — pure domain math behind the
 * server-rendered drill view that replaces the decomposition chart.
 *
 * A drill key resolves a group of liquidity tiers: "liquid" (cash + market),
 * "rest" (retirement + illiquid), and "housing" (the single housing tier).
 * Everything is derived exclusively from frozen snapshot holding rows
 * (per-tier aggregates are never stored, ADR 0008): a per-tier stacked series
 * over time (net per frozen tier = asset rows − liability rows), reusing the
 * decomposition stack geometry with its deterministic stack→lines fallback,
 * plus per-holding sparkline entries for the small-multiples grid. Housing is
 * a single tier, so its drill skips the stack and goes straight to the
 * per-property multiples. No React, no SVG — just numbers and strings.
 */

import type { LiquidityTier } from "./classification";
import {
  buildStackedChartGeometry,
  type StackedChartGeometry,
} from "./decomposition-chart";
import { paddedValueDomain, timeProportionalXs, valueToY } from "./evolution-chart";
import type { SnapshotHoldingKind, SnapshotHoldingRow } from "./snapshot-holdings";

/** The drill keys the home understands (#76 liquid, #77 rest + housing). */
export type DrilldownKey = "liquid" | "rest" | "housing";

/** The liquid group: the tiers that make up liquid net worth. */
export const LIQUID_DRILL_TIERS = ["cash", "market"] as const;

export type LiquidDrillTier = (typeof LIQUID_DRILL_TIERS)[number];

/** The rest group: retirement plus the illiquid remainder (#77). */
export const REST_DRILL_TIERS = ["retirement", "illiquid"] as const;

export type RestDrillTier = (typeof REST_DRILL_TIERS)[number];

/** The housing group: a single tier — its drill has no stack (#77). */
export const HOUSING_DRILL_TIERS = ["housing"] as const;

export type HousingDrillTier = (typeof HOUSING_DRILL_TIERS)[number];

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

/** Every drill group builds from the same input shape (#77). */
export type DrilldownInput = LiquidDrilldownInput;

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

/** The drill view state of one tier group (#77 generalizes #76's liquid shape). */
export interface GroupDrilldownState<
  Key extends DrilldownKey,
  Tier extends LiquidityTier,
> {
  key: Key;
  /**
   * Per-tier stacked series over time (in group tier order), or `null` below
   * the two-point placeholder threshold — and always `null` for single-tier
   * groups (housing), which skip the stack by design.
   */
  stack: StackedChartGeometry<Tier> | null;
  /** Small-multiple entries, ordered by label for a stable presentation. */
  holdings: DrillHoldingMultiple[];
}

export type LiquidDrilldownState = GroupDrilldownState<"liquid", LiquidDrillTier>;

export type RestDrilldownState = GroupDrilldownState<"rest", RestDrillTier>;

export type HousingDrilldownState = GroupDrilldownState<"housing", HousingDrillTier>;

/** Any active drill view state, discriminated by `key`. */
export type DrilldownState =
  | LiquidDrilldownState
  | RestDrilldownState
  | HousingDrilldownState;

/** A group row: a dated holding row whose frozen tier belongs to the drill group. */
type GroupRow<Tier extends LiquidityTier> = DatedSnapshotHoldingRow & {
  liquidityTier: Tier;
};

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

/** Per-tier stacked series: one point per capture day of the group. */
function buildGroupStack<Tier extends LiquidityTier>(
  groupRows: Array<GroupRow<Tier>>,
  tiers: readonly Tier[],
): StackedChartGeometry<Tier> | null {
  const dateKeys = [...new Set(groupRows.map((row) => row.dateKey))];
  const netByTierByDate = new Map<string, Map<Tier, number>>(
    dateKeys.map((dateKey) => [
      dateKey,
      new Map(tiers.map((tier) => [tier, 0])),
    ]),
  );

  for (const row of groupRows) {
    const tierNets = netByTierByDate.get(row.dateKey)!;
    tierNets.set(row.liquidityTier, tierNets.get(row.liquidityTier)! + signedValueMinor(row));
  }

  return buildStackedChartGeometry<Tier>(
    dateKeys,
    tiers.map((tier) => ({
      band: tier,
      values: dateKeys.map((dateKey) => netByTierByDate.get(dateKey)!.get(tier)!),
    })),
  );
}

/**
 * Builds one group's drill view state from frozen snapshot holding rows:
 * the per-tier stacked series (unless the group skips it — housing) and the
 * per-holding small multiples. The grouping is the only parameterized part;
 * the per-holding presentation is shared by every drill key (#78 refines it
 * in one place).
 */
function buildGroupDrilldown<Key extends DrilldownKey, Tier extends LiquidityTier>(
  key: Key,
  tiers: readonly Tier[],
  input: DrilldownInput,
  options: { withStack: boolean },
): GroupDrilldownState<Key, Tier> {
  const tierSet = new Set<LiquidityTier>(tiers);
  const groupRows = input.rows
    .filter(
      (row): row is GroupRow<Tier> =>
        row.liquidityTier !== null && tierSet.has(row.liquidityTier),
    )
    .sort((a, b) => a.dateKey.localeCompare(b.dateKey));

  const stack = options.withStack ? buildGroupStack(groupRows, tiers) : null;

  // ── Per-holding small multiples: holdings with ≥2 captured points ────────
  const rowsByHolding = new Map<string, Array<GroupRow<Tier>>>();

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

  return { holdings, key, stack };
}

/**
 * Builds the liquid drill view state from frozen snapshot holding rows:
 * the cash-vs-market stacked series and the per-holding small multiples.
 */
export function buildLiquidDrilldown(input: LiquidDrilldownInput): LiquidDrilldownState {
  return buildGroupDrilldown("liquid", LIQUID_DRILL_TIERS, input, { withStack: true });
}

/**
 * Builds the rest drill view state (#77): the retirement-vs-illiquid stacked
 * series and the per-holding small multiples.
 */
export function buildRestDrilldown(input: DrilldownInput): RestDrilldownState {
  return buildGroupDrilldown("rest", REST_DRILL_TIERS, input, { withStack: true });
}

/**
 * Builds the housing drill view state (#77): a single tier, so there is no
 * stack — straight to the per-property small multiples, answering "which
 * property revalued more".
 */
export function buildHousingDrilldown(input: DrilldownInput): HousingDrilldownState {
  return buildGroupDrilldown("housing", HOUSING_DRILL_TIERS, input, {
    withStack: false,
  });
}

/** Dispatch a drill key to its group builder (#77). */
export function buildDrilldown(key: DrilldownKey, input: DrilldownInput): DrilldownState {
  switch (key) {
    case "liquid":
      return buildLiquidDrilldown(input);
    case "rest":
      return buildRestDrilldown(input);
    case "housing":
      return buildHousingDrilldown(input);
  }
}
