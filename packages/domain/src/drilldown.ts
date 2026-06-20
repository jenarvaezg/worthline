/**
 * Drilldown state module (#76, #77, #78) — pure domain math behind the
 * server-rendered drill view that replaces the decomposition chart.
 *
 * A drill key resolves a group: "liquid" (cash + market rungs), "rest" (the
 * term-locked + illiquid rungs), and "housing" — the scope's real-estate
 * holdings, now a real fifth rung of the ladder (ADR 0022), so every surface
 * classifies the home identically.
 * Everything is derived exclusively from frozen snapshot holding rows
 * (per-tier aggregates are never stored, ADR 0008): a per-tier stacked series
 * over time (net per frozen tier = asset rows − liability rows), reusing the
 * decomposition stack geometry with its deterministic stack→lines fallback,
 * plus per-holding sparkline entries for the small-multiples grid. Housing is
 * a single tier, so its drill skips the stack and goes straight to the
 * per-property multiples. No React, no SVG — just numbers and strings.
 *
 * Frozen means frozen (#78, ADR 0008): a holding that has left the portfolio —
 * sold, written off, deleted, with or without losses — keeps its captured
 * history in the AGGREGATE stack/composition series. Its per-holding small
 * multiple, however, is dropped from the grid (this design pass): the cards
 * show only currently-held holdings, so the grid stays a snapshot of the live
 * portfolio while the aggregate still tells the full historical story.
 */

import type { LiquidityTier } from "./classification";
import {
  buildStackedChartGeometry,
  type StackedChartGeometry,
} from "./decomposition-chart";
import type { SnapshotHoldingKind, SnapshotHoldingRow } from "./snapshot-holdings";

/** The drill keys the home understands (#76 liquid, #77 rest + housing, #145 debts). */
export type DrilldownKey = "liquid" | "rest" | "housing" | "debts";

/** The liquid group: the tiers that make up liquid net worth. */
export const LIQUID_DRILL_TIERS = ["cash", "market"] as const;

export type LiquidDrillTier = (typeof LIQUID_DRILL_TIERS)[number];

/** The rest group: the term-locked and illiquid rungs (#77). Housing has its own
 *  rung now (ADR 0022), so it is naturally excluded from this group. */
export const REST_DRILL_TIERS = ["term-locked", "illiquid"] as const;

export type RestDrillTier = (typeof REST_DRILL_TIERS)[number];

// The housing group has no stack tier constant: housing is a single rung, so its
// drill skips the stack and goes straight to the per-property multiples (#77).

/**
 * The drill group each liquidity tier resolves to (#79): the inverse of the
 * group tier constants above, shared by every surface that links a tier to
 * its drill view (the home's tier donut today) so destinations stay coherent
 * with the decomposition bands.
 */
export const DRILL_GROUP_BY_TIER: Record<LiquidityTier, DrilldownKey> = {
  cash: "liquid",
  housing: "housing",
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
   * Ids of holdings sitting in the Papelera — soft-deleted, recoverable (#268).
   * They are already absent from `currentHoldingIds`, so they are dropped from
   * the per-holding multiples like any other not-currently-held holding (this
   * design pass). Retained as a parameter for parity and call-site clarity;
   * optional — omit (or pass `[]`) when nothing is trashed. Either way a
   * dropped holding's past value still lives in the aggregate history.
   */
  trashedHoldingIds?: readonly string[];
}

/** Every drill group builds from the same input shape (#77). */
export type DrilldownInput = LiquidDrilldownInput;

export const DRILL_SPARKLINE_WIDTH = 120;
export const DRILL_SPARKLINE_HEIGHT = 36;
/**
 * Floor for a sparkline bar's height, in viewBox units. A holding with only one
 * or two captures (or a near-flat history) still renders as a clean discrete
 * tick instead of a degenerate sliver — the same floor the prototype settled on
 * for the all-bars drilldown (this design pass).
 */
export const DRILL_SPARKLINE_MIN_BAR_HEIGHT = 1.5;

/** One sparkline bar rectangle of one capture, in viewBox space. */
export interface DrillBarRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DrillSparklineGeometry {
  width: number;
  height: number;
  /**
   * One bar per capture, growing from the viewBox floor up to its value (bars,
   * not a polyline — this design pass), mirroring the main composition chart's
   * bar language. Heights are floored at {@link DRILL_SPARKLINE_MIN_BAR_HEIGHT}
   * so sparse histories still read as discrete ticks.
   */
  bars: DrillBarRect[];
}

/** One small-multiple entry: a holding with at least two captured points. */
export interface DrillHoldingMultiple {
  holdingId: string;
  kind: SnapshotHoldingKind;
  /** The holding's label as frozen at its latest capture in the window. */
  label: string;
  /**
   * The holding's tier as frozen at its latest capture in the window; `null` for
   * an unsecured liability in the debts drill (#145) — those carry no rung.
   */
  tier: LiquidityTier | null;
  sparkline: DrillSparklineGeometry;
  /**
   * The holding's latest captured scoped value. Always present: only
   * currently-held holdings reach the multiples now (this design pass), so a
   * card never carries a missing present.
   */
  currentValueMinor: number;
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
   * Small-multiple entries — only currently-held holdings (this design pass),
   * ordered by label for a stable presentation. A retired holding's past value
   * still lives in the aggregate stack history; only its card is dropped.
   */
  holdings: DrillHoldingMultiple[];
}

export type LiquidDrilldownState = GroupDrilldownState<"liquid", LiquidDrillTier>;

export type RestDrilldownState = GroupDrilldownState<"rest", RestDrillTier>;

// Housing is a single rung (ADR 0022), so its drill never stacks (Tier = never).
export type HousingDrilldownState = GroupDrilldownState<"housing", never>;

/** The single synthetic band of the aggregate debt series (#145). */
export type DebtDrillBand = "debts";

/**
 * The debts drill view state (#145): ALL liabilities — secured and unsecured —
 * aggregated into one debt series over time (mirroring the main chart's single
 * debt band), plus per-debt small multiples. Shares the `{ key, stack, holdings }`
 * shape of the tier groups so the panel renders it uniformly; here `stack` is the
 * aggregate area rather than a per-tier stack.
 */
export interface DebtsDrilldownState {
  key: "debts";
  /** The aggregate debt area (single "debts" band), or `null` below the threshold. */
  stack: StackedChartGeometry<DebtDrillBand> | null;
  /** Per-debt small multiples — only currently-live debts (this design pass). */
  holdings: DrillHoldingMultiple[];
}

/** Any active drill view state, discriminated by `key`. */
export type DrilldownState =
  | LiquidDrilldownState
  | RestDrilldownState
  | HousingDrilldownState
  | DebtsDrilldownState;

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

/** Fraction of a capture's slot a sparkline bar fills — the rest is gutter. */
const SPARKLINE_BAR_WIDTH_RATIO = 0.7;

/**
 * Sparkline geometry for one holding, as per-capture BARS (this design pass).
 * Captures are spaced evenly across the viewBox — one discrete tick per capture,
 * the approved prototype geometry — rather than on a shared time axis, which the
 * old polyline only needed for the now-removed no-longer-held truncation. Each
 * bar grows from the viewBox floor up to its value, scaled against the holding's
 * own peak and floored at {@link DRILL_SPARKLINE_MIN_BAR_HEIGHT} so even a one-
 * or two-capture history reads as clean ticks rather than a degenerate sliver.
 * `windowSpanMs` is still the group-window guard: a degenerate (zero-day) window
 * draws no sparklines at all.
 */
function buildSparkline(
  dateKeys: string[],
  valuesMinor: number[],
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

  const n = valuesMinor.length;
  const slot = DRILL_SPARKLINE_WIDTH / n;
  const barWidth = round2(slot * SPARKLINE_BAR_WIDTH_RATIO);
  // Scale heights against the holding's own peak from a zero floor (≥ 1 guards a
  // flat-zero history), so the tallest bar fills the sparkline and shape reads.
  const peak = Math.max(...valuesMinor.map((v) => Math.abs(v)), 1);

  const bars = valuesMinor.map((value, i) => {
    const height = round2(
      Math.max(
        DRILL_SPARKLINE_MIN_BAR_HEIGHT,
        (Math.abs(value) / peak) * DRILL_SPARKLINE_HEIGHT,
      ),
    );
    return {
      height,
      width: barWidth,
      x: round2(slot * (i + 0.5) - barWidth / 2),
      y: round2(DRILL_SPARKLINE_HEIGHT - height),
    };
  });

  return {
    bars,
    height: DRILL_SPARKLINE_HEIGHT,
    width: DRILL_SPARKLINE_WIDTH,
  };
}

/**
 * Builds the per-holding small-multiple entries of a drill group from its
 * frozen rows. Shared by every drill key so all groups inherit the rules:
 * a holding needs ≥2 captured points in the window to appear, AND it must
 * still be in the portfolio — a holding that has left (sold, written off,
 * hard-deleted) is dropped from the cards entirely (this design pass), as are
 * Papelera (soft-deleted) holdings. Either way the retired holding's past value
 * still lives in the aggregate stack history (frozen rows, ADR 0008); only its
 * per-holding card is dropped. Entries are ordered by label (then id) for a
 * stable presentation.
 */
export function buildDrillHoldingMultiples(
  groupRows: readonly DatedSnapshotHoldingRow[],
  currentHoldingIds: readonly string[],
  trashedHoldingIds: readonly string[] = [],
): DrillHoldingMultiple[] {
  const sortedRows = [...groupRows].sort((a, b) => a.dateKey.localeCompare(b.dateKey));

  if (sortedRows.length === 0) return [];

  const windowSpanMs =
    parseDateKey(sortedRows.at(-1)!.dateKey) - parseDateKey(sortedRows[0]!.dateKey);

  const rowsByHolding = new Map<string, DatedSnapshotHoldingRow[]>();

  for (const row of sortedRows) {
    rowsByHolding.set(row.holdingId, [...(rowsByHolding.get(row.holdingId) ?? []), row]);
  }

  const heldIds = new Set(currentHoldingIds);
  const trashedIds = new Set(trashedHoldingIds);

  return [...rowsByHolding.entries()]
    .flatMap(([holdingId, rows]) => {
      // Drop everything not currently in the portfolio: Papelera holdings
      // (soft-deleted, recoverable, #268) AND retired ones (sold/written-off/
      // hard-deleted). The cards show only live holdings now (this design pass);
      // a retired holding's past value still lives in the aggregate stack
      // history (frozen rows, ADR 0008), so only the per-holding card is lost.
      if (trashedIds.has(holdingId) || !heldIds.has(holdingId)) return [];

      const sparkline = buildSparkline(
        rows.map((row) => row.dateKey),
        rows.map((row) => row.valueMinor),
        windowSpanMs,
      );

      if (rows.length < 2 || !sparkline) return [];

      const latest = rows.at(-1)!;

      return [
        {
          currentValueMinor: latest.valueMinor,
          holdingId,
          kind: latest.kind,
          label: latest.label,
          sparkline,
          tier: effectiveRung(latest),
        } satisfies DrillHoldingMultiple,
      ];
    })
    .sort(
      (a, b) => a.label.localeCompare(b.label) || a.holdingId.localeCompare(b.holdingId),
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
 * The effective rung a frozen row drills into: its frozen tier, but a legacy
 * house (frozen `illiquid` before the v28 recut) still resolves to `housing` via
 * `countsAsHousing`, and a legacy housing-secured mortgage resolves to `housing`
 * via `securesHousing` — so both sides of housing equity bucket identically
 * regardless of stored tier (ADR 0022).
 */
function effectiveRung<Tier extends LiquidityTier | null>(row: {
  liquidityTier: Tier;
  countsAsHousing: boolean;
  securesHousing: boolean;
}): "housing" | Tier {
  return row.countsAsHousing || row.securesHousing ? "housing" : row.liquidityTier;
}

/**
 * Selects the frozen rows of a tier group (liquid, rest): rows whose effective
 * rung is in `tiers`. Housing now has its own `housing` rung (ADR 0022), so a
 * house resolves to `housing` and is naturally excluded from `rest` — no
 * by-id carve, no double-count.
 */
function tierGroupSelect(
  tiers: readonly LiquidityTier[],
): (row: DrillGroupRow) => boolean {
  const tierSet = new Set<LiquidityTier>(tiers);
  return (row) => tierSet.has(effectiveRung(row));
}

/**
 * Selects the frozen rows of the housing group: ASSET rows whose effective rung
 * is `housing` (ADR 0022) — every property instrument, plus a legacy house
 * frozen `illiquid` with `countsAsHousing` true. Housing-securing mortgages are
 * deliberately EXCLUDED: a mortgage is a debt and belongs in the debts drill,
 * not under "Vivienda · Propiedades". (The Vivienda band is shown net of its
 * mortgage in the main chart, but the drill lists the properties themselves; the
 * securing debt is reachable from the debts drill.)
 */
function housingSelect(): (row: DrillGroupRow) => boolean {
  return (row) => row.kind !== "liability" && effectiveRung(row) === "housing";
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
  const holdings = buildDrillHoldingMultiples(
    groupRows,
    input.currentHoldingIds,
    input.trashedHoldingIds,
  );

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
    tierGroupSelect(LIQUID_DRILL_TIERS),
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
    tierGroupSelect(REST_DRILL_TIERS),
    REST_DRILL_TIERS,
  );
}

/**
 * Builds the housing drill view state (#77): the housing rung is a single tier
 * (ADR 0022), so there is no stack — straight to the per-property small
 * multiples, answering "which property revalued more".
 */
export function buildHousingDrilldown(input: DrilldownInput): HousingDrilldownState {
  return buildGroupDrilldown<"housing", never>("housing", input, housingSelect(), null);
}

/**
 * Builds the debts drill view state (#145): every liability — secured or not —
 * summed into one debt series over time (mirroring the main chart's single debt
 * band), plus the per-debt small multiples. Unlike the tier groups it never
 * filters by rung, so an unsecured debt (null rung) belongs here too. A debt
 * that has left the portfolio keeps its captured history, flagged and ordered
 * after the live ones (#78), exactly like the other drilldowns.
 */
export function buildDebtsDrilldown(input: DrilldownInput): DebtsDrilldownState {
  const debtRows = input.rows
    .filter((row) => row.kind === "liability")
    .sort((a, b) => a.dateKey.localeCompare(b.dateKey));

  const dateKeys = [...new Set(debtRows.map((row) => row.dateKey))];
  const totalByDate = new Map<string, number>(dateKeys.map((dateKey) => [dateKey, 0]));
  for (const row of debtRows) {
    totalByDate.set(row.dateKey, totalByDate.get(row.dateKey)! + row.valueMinor);
  }

  const stack = buildStackedChartGeometry<DebtDrillBand>(dateKeys, [
    { band: "debts", values: dateKeys.map((dateKey) => totalByDate.get(dateKey)!) },
  ]);
  const holdings = buildDrillHoldingMultiples(
    debtRows,
    input.currentHoldingIds,
    input.trashedHoldingIds,
  );

  return { holdings, key: "debts", stack };
}

/** Dispatch a drill key to its group builder (#77, #145). */
export function buildDrilldown(key: DrilldownKey, input: DrilldownInput): DrilldownState {
  switch (key) {
    case "liquid":
      return buildLiquidDrilldown(input);
    case "rest":
      return buildRestDrilldown(input);
    case "housing":
      return buildHousingDrilldown(input);
    case "debts":
      return buildDebtsDrilldown(input);
  }
}
