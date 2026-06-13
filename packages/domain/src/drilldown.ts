/**
 * Drilldown state module (#76, #77, #78) — pure domain math behind the
 * server-rendered drill view that replaces the decomposition chart.
 *
 * A drill key resolves a group: "liquid" (cash + market rungs), "rest" (the
 * term-locked + illiquid rungs, minus housing), and "housing" — the scope's
 * real-estate holdings, sourced by holding id rather than by rung, since
 * housing is no longer a tier (ADR 0013 bridge).
 * Everything is derived exclusively from frozen snapshot holding rows
 * (per-tier aggregates are never stored, ADR 0008): a per-tier stacked series
 * over time (net per frozen tier = asset rows − liability rows), reusing the
 * decomposition stack geometry with its deterministic stack→lines fallback,
 * plus per-holding sparkline entries for the small-multiples grid. Housing is
 * a single tier, so its drill skips the stack and goes straight to the
 * per-property multiples. No React, no SVG — just numbers and strings.
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

/** The drill keys the home understands (#76 liquid, #77 rest + housing). */
export type DrilldownKey = "liquid" | "rest" | "housing";

/** The liquid group: the tiers that make up liquid net worth. */
export const LIQUID_DRILL_TIERS = ["cash", "market"] as const;

export type LiquidDrillTier = (typeof LIQUID_DRILL_TIERS)[number];

/** The rest group: the term-locked and illiquid rungs, minus housing (#77). */
export const REST_DRILL_TIERS = ["term-locked", "illiquid"] as const;

export type RestDrillTier = (typeof REST_DRILL_TIERS)[number];

// The housing group has no tier constant: housing is no longer a rung (ADR 0013
// bridge). It is sourced by holding id — see `buildHousingDrilldown` — and its
// drill never stacks (#77).

/**
 * The drill group each liquidity tier resolves to (#79): the inverse of the
 * group tier constants above, shared by every surface that links a tier to
 * its drill view (the home's tier donut today) so destinations stay coherent
 * with the decomposition bands.
 */
export const DRILL_GROUP_BY_TIER: Record<LiquidityTier, DrilldownKey> = {
  cash: "liquid",
  illiquid: "rest",
  market: "liquid",
  "term-locked": "rest",
} as const;

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
  /**
   * Ids of the scope's housing holdings (real-estate). Housing is sourced by id,
   * not by rung (ADR 0013 bridge): the housing drill takes exactly these, and the
   * tier groups exclude them so a house on `illiquid` is never double-counted.
   * Required (pass `[]` when the scope has no housing) so the no-double-count
   * invariant can never hinge on a caller forgetting an optional field.
   */
  housingHoldingIds: readonly string[];
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
   * portfolio; `null` when no longer held.
   */
  currentValueMinor: number | null;
  /** True when the holding has left the portfolio (sold, written off, deleted). */
  noLongerHeld: boolean;
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
  /**
   * Small-multiple entries: currently-held holdings first, no-longer-held
   * ones at the end, each group ordered by label for a stable presentation.
   */
  holdings: DrillHoldingMultiple[];
}

export type LiquidDrilldownState = GroupDrilldownState<"liquid", LiquidDrillTier>;

export type RestDrilldownState = GroupDrilldownState<"rest", RestDrillTier>;

// Housing is sourced by id, not a rung, so its drill never stacks (Tier = never).
export type HousingDrilldownState = GroupDrilldownState<"housing", never>;

/** Any active drill view state, discriminated by `key`. */
export type DrilldownState =
  | LiquidDrilldownState
  | RestDrilldownState
  | HousingDrilldownState;

/** A drill group row: a dated holding row whose frozen tier resolved into the group. */
export type DrillGroupRow = DatedSnapshotHoldingRow & { liquidityTier: LiquidityTier };

/** A group row: a dated holding row whose frozen tier belongs to the drill group. */
type GroupRow<Tier extends LiquidityTier> = DatedSnapshotHoldingRow & {
  liquidityTier: Tier;
};

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

/** Per-tier stacked series: one point per capture day of the group. */
function buildGroupStack<Tier extends LiquidityTier>(
  groupRows: Array<GroupRow<Tier>>,
  tiers: readonly Tier[],
): StackedChartGeometry<Tier> | null {
  const dateKeys = [...new Set(groupRows.map((row) => row.dateKey))];
  const netByTierByDate = new Map<string, Map<Tier, number>>(
    dateKeys.map((dateKey) => [dateKey, new Map(tiers.map((tier) => [tier, 0]))]),
  );

  for (const row of groupRows) {
    const tierNets = netByTierByDate.get(row.dateKey)!;
    tierNets.set(
      row.liquidityTier,
      tierNets.get(row.liquidityTier)! + signedValueMinor(row),
    );
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
 * Selects the frozen rows of a tier group (liquid, rest): rows whose frozen rung
 * is in `tiers`, excluding housing holdings — a house sits on `illiquid` but
 * belongs to the housing drill, never to `rest`, so it is never double-counted
 * (ADR 0013 bridge).
 */
function tierGroupSelect(
  tiers: readonly LiquidityTier[],
  housingHoldingIds: readonly string[],
): (row: DrillGroupRow) => boolean {
  const tierSet = new Set<LiquidityTier>(tiers);
  const housingIds = new Set(housingHoldingIds);
  return (row) => tierSet.has(row.liquidityTier) && !housingIds.has(row.holdingId);
}

/**
 * Selects the frozen rows of the housing group: exactly the scope's housing
 * holdings, sourced by id rather than by rung (ADR 0013 bridge).
 */
function housingSelect(
  housingHoldingIds: readonly string[],
): (row: DrillGroupRow) => boolean {
  const housingIds = new Set(housingHoldingIds);
  return (row) => housingIds.has(row.holdingId);
}

/**
 * Builds one group's drill view state from frozen snapshot holding rows: the
 * per-tier stacked series (only when the group stacks) and the per-holding small
 * multiples. The only thing that varies between groups is which rows belong —
 * injected as `select` — so every drill key shares one filter→sort→multiples
 * pipeline (#78 refines it in one place). Tier groups pass their rungs as
 * `stackTiers` and stack; housing passes `null` and skips the stack by design.
 */
function buildGroupDrilldown<Key extends DrilldownKey, Tier extends LiquidityTier>(
  key: Key,
  input: DrilldownInput,
  select: (row: DrillGroupRow) => boolean,
  stackTiers: readonly Tier[] | null,
): GroupDrilldownState<Key, Tier> {
  const groupRows = input.rows
    .filter(
      (row): row is DrillGroupRow =>
        row.liquidityTier !== null && select(row as DrillGroupRow),
    )
    .sort((a, b) => a.dateKey.localeCompare(b.dateKey));

  // A tier group guarantees every selected row's rung is one of `stackTiers`;
  // housing passes `null` and never reaches this branch.
  const stack = stackTiers
    ? buildGroupStack(groupRows as Array<GroupRow<Tier>>, stackTiers)
    : null;
  const holdings = buildDrillHoldingMultiples(groupRows, input.currentHoldingIds);

  return { holdings, key, stack };
}

/**
 * Builds the liquid drill view state from frozen snapshot holding rows:
 * the cash-vs-market stacked series and the per-holding small multiples.
 */
export function buildLiquidDrilldown(input: LiquidDrilldownInput): LiquidDrilldownState {
  return buildGroupDrilldown(
    "liquid",
    input,
    tierGroupSelect(LIQUID_DRILL_TIERS, input.housingHoldingIds),
    LIQUID_DRILL_TIERS,
  );
}

/**
 * Builds the rest drill view state (#77): the term-locked-vs-illiquid stacked
 * series and the per-holding small multiples (housing excluded).
 */
export function buildRestDrilldown(input: DrilldownInput): RestDrilldownState {
  return buildGroupDrilldown(
    "rest",
    input,
    tierGroupSelect(REST_DRILL_TIERS, input.housingHoldingIds),
    REST_DRILL_TIERS,
  );
}

/**
 * Builds the housing drill view state (#77): sourced by holding id, so there is
 * no stack — straight to the per-property small multiples, answering "which
 * property revalued more".
 */
export function buildHousingDrilldown(input: DrilldownInput): HousingDrilldownState {
  return buildGroupDrilldown<"housing", never>(
    "housing",
    input,
    housingSelect(input.housingHoldingIds),
    null,
  );
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
