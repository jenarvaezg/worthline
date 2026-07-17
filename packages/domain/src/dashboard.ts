import type { ContributionPlan } from "./contribution-plan";
import { resolveMonthlySavingsCapacityForFire } from "./contribution-plan";
import type { DashboardShell } from "./dashboard-shell";
import { createDashboardShell } from "./dashboard-shell";
import type { FireScopeConfig } from "./fire";
import {
  calculateFireForScope,
  fireReservationHorizon,
  isFireEligibleAsset,
  projectFireFromContext,
} from "./fire";
import type { FireLevel } from "./fire-levels";
import { fireLevels } from "./fire-levels";
import type { FireProjection } from "./fire-projection";
import type { GoalFireDelay } from "./goal-fire-delay";
import { goalFireDelay } from "./goal-fire-delay";
import type { Goal } from "./goals";
import {
  assignedHoldingsValueMinor,
  goalFundedRatioBps,
  goalReservedMinor,
  totalGoalReservationMinor,
} from "./goals";
import type { PositionSummary } from "./investment-types";
import type {
  LiquidityTierBreakdown,
  NetWorthFraming,
  NetWorthPresentation,
  NetWorthSummary,
} from "./net-worth";
import { buildLiquidityBreakdown, calculateNetWorth, presentNetWorth } from "./net-worth";
import type { LocalPersistenceStatus } from "./persistence";
import type { AssetPrice } from "./prices";
import { unitPriceMajorByHoldingId } from "./prices";
import type { ScopeOption } from "./scope";
import { resolveScopeMemberIds } from "./scope";
import type { NetWorthSnapshot, SnapshotDeltas } from "./snapshot-types";
import { calculateSnapshotDeltas } from "./snapshot-types";
import type { DomainWarning, WarningOverride } from "./warnings";
import { collectWarnings } from "./warnings";
import type { Liability, ManualAsset, Member, Workspace } from "./workspace-types";

export type { LocalPersistenceStatus };

export interface PositionView extends PositionSummary {
  name: string;
}

/**
 * Converts an array of raw values (e.g. bps counts) into integer percentages
 * that sum to exactly 100 using the Largest Remainder Method.
 * Preserves input order. All-zero inputs return all zeros.
 */
export function largestRemainderPercentages(values: number[]): number[] {
  if (values.length === 0) return [];

  const total = values.reduce((sum, v) => sum + v, 0);

  if (total === 0) return values.map(() => 0);

  const floats = values.map((v) => (v / total) * 100);
  const floors = floats.map((f) => Math.floor(f));
  const remainders = floats.map((f, i) => f - floors[i]!);
  const deficit = 100 - floors.reduce((a, b) => a + b, 0);

  // Sort indices by remainder descending, allocate the deficit 1-by-1.
  const order = remainders
    .map((r, i) => ({ i, r }))
    .sort((a, b) => b.r - a.r)
    .map((x) => x.i);

  for (let k = 0; k < deficit; k++) {
    floors[order[k]!]! += 1;
  }

  return floors;
}

export interface OnboardingStep {
  id: string;
  label: string;
  done: boolean;
}

/**
 * The ordered "first steps" a new workspace should complete, each marked done
 * from the current counts. Pure — drives the first-run checklist and the
 * empty-state guidance.
 */
export function deriveOnboardingProgress(input: {
  activeMemberCount: number;
  holdingCount: number;
  hasFireConfig: boolean;
  snapshotCount: number;
}): OnboardingStep[] {
  return [
    { id: "members", label: "Revisa los miembros", done: input.activeMemberCount > 0 },
    {
      id: "holdings",
      label: "Añade tu primer holding",
      done: input.holdingCount > 0,
    },
    { id: "fire", label: "Configura FIRE", done: input.hasFireConfig },
    {
      id: "snapshot",
      label: "Tu primer snapshot se captura automáticamente",
      done: input.snapshotCount > 0,
    },
  ];
}

/**
 * Compact summary of FIRE state for the home glance card (PRD #507, S1).
 * All values derived from `fireResult` + `fireProjection` + goals reservation —
 * no new projection math here.
 */
export interface FireGlance {
  /** 0–100+, matches `FireResult.percentFunded`. */
  percentFunded: number;
  /** coastRequired / fireNumber (0–1); null when coast data is unavailable. */
  coastTickFraction: number | null;
  /** True when already at Coast FIRE. */
  isAlreadyAtCoastFire: boolean;
  /** True when fully FIRE funded. */
  isFunded: boolean;
  /** Whole years to FIRE from the base scenario; null if beyond the horizon. */
  yearsToFire: number | null;
  /** Number of active goals for the scope. */
  goalsCount: number;
  /** Total capital reserved for goals (minor units). */
  goalsReservedMinor: number;
}

export interface DashboardState {
  persistence: LocalPersistenceStatus;
  workspace: Workspace | null;
  assets: ManualAsset[];
  liabilities: Liability[];
  positions: PositionView[];
  priceCache: AssetPrice[];
  scopes: ScopeOption[];
  selectedScope: ScopeOption | undefined;
  snapshots: NetWorthSnapshot[];
  summary: NetWorthSummary | undefined;
  presentation: NetWorthPresentation | undefined;
  fireScopeConfig: FireScopeConfig | null;
  fireResult: ReturnType<typeof calculateFireForScope> | null;
  /** FIRE projection scenarios (PRD #421, #427); null when FIRE is unconfigured. */
  fireProjection: FireProjection | null;
  /** Compact glance data for the home FIRE card (PRD #507, S1); null when unconfigured. */
  fireGlance: FireGlance | null;
  selectedMemberIds: string[];
  pyramid: LiquidityTierBreakdown[];
  deltas: SnapshotDeltas | undefined;
  dashboard: DashboardShell;
  activeMembers: Member[];
  investmentAssets: ManualAsset[];
  today: string;
  warnings: DomainWarning[];
  onboarding: OnboardingStep[];
  selectedView: NetWorthFraming;
}

export function prepareDashboardState(input: {
  persistence: LocalPersistenceStatus;
  workspace: Workspace | null;
  assets: ManualAsset[];
  liabilities: Liability[];
  positions: PositionView[];
  priceCache: AssetPrice[];
  scopes: ScopeOption[];
  selectedScope: ScopeOption | undefined;
  snapshots: NetWorthSnapshot[];
  fireConfig: Record<string, FireScopeConfig>;
  selectedView: NetWorthFraming;
  overrides?: WarningOverride[];
  /** Goals for the selected scope (PRD #421, #426); reserve capital against FIRE. */
  goals?: Goal[];
  /** Today (YYYY-MM-DD), for the goal-reservation horizon; defaults to the system date. */
  today?: string;
  /** Scope contribution plan (ADR 0041); drives derived monthly savings for FIRE. */
  contributionPlan?: ContributionPlan | null;
}): DashboardState {
  const { workspace, assets, liabilities, selectedScope, persistence } = input;
  const today = input.today ?? new Date().toISOString().slice(0, 10);
  const unitPrices = unitPriceMajorByHoldingId(input.priceCache);

  const summary =
    workspace && selectedScope
      ? calculateNetWorth({
          assets,
          liabilities,
          scopeId: selectedScope.id,
          workspace,
        })
      : undefined;

  const presentation = summary ? presentNetWorth(summary, input.selectedView) : undefined;

  const fireScopeConfig: FireScopeConfig | null = selectedScope
    ? (input.fireConfig[selectedScope.id] ?? null)
    : null;

  const fireReservedMinor =
    fireScopeConfig && workspace && selectedScope
      ? (() => {
          const now = input.today ?? new Date().toISOString().slice(0, 10);
          const memberIds = new Set(resolveScopeMemberIds(workspace, selectedScope.id));
          const assetById = new Map(assets.map((asset) => [asset.id, asset]));
          return totalGoalReservationMinor(
            (input.goals ?? []).map((goal) => ({
              targetAmountMinor: goal.targetAmountMinor,
              deadline: goal.deadline,
              assignedValueMinor: assignedHoldingsValueMinor(
                goal.assetIds,
                assetById,
                memberIds,
                (asset) => isFireEligibleAsset(asset, fireScopeConfig),
              ),
            })),
            now,
            fireReservationHorizon(fireScopeConfig, now),
          );
        })()
      : 0;

  const fireResult =
    fireScopeConfig && workspace && selectedScope
      ? calculateFireForScope(
          fireScopeConfig,
          assets,
          liabilities,
          workspace,
          selectedScope.id,
          fireReservedMinor,
        )
      : null;

  // FIRE projection (#427): scenarios from the reservation-adjusted eligible
  // total and the configured monthly savings capacity. The resolved rate, FIRE
  // number and age ride in the context (#1026), so coast + projection + levels
  // agree by construction — no rate to thread by hand, no fallback.
  const fireProjection = fireResult
    ? projectFireFromContext(fireResult.context, {
        monthlyContributionMinor: resolveMonthlySavingsCapacityForFire(
          input.contributionPlan,
          fireResult.context.config,
          today,
          unitPrices,
        ).capacityMinor,
      })
    : null;

  const selectedMemberIds =
    workspace && selectedScope ? resolveScopeMemberIds(workspace, selectedScope.id) : [];

  const pyramid =
    workspace && selectedScope
      ? buildLiquidityBreakdown({
          assets,
          liabilities,
          scopeId: selectedScope.id,
          workspace,
        })
      : [];

  const latestSnapshot = input.snapshots.at(-1);
  const deltas = latestSnapshot
    ? calculateSnapshotDeltas(input.snapshots, latestSnapshot.id)
    : undefined;

  const dashboard = createDashboardShell({
    moduleStates: {
      liquidity: workspace ? "ready" : "empty",
      members: workspace ? "ready" : "empty",
      ownership: assets.length > 0 || liabilities.length > 0 ? "ready" : "empty",
      snapshots: input.snapshots.length > 0 ? "ready" : "empty",
    },
    persistence,
    ...(summary ? { summary } : {}),
  });

  const activeMembers = workspace?.members.filter((member) => !member.disabledAt) ?? [];
  const investmentAssets = assets.filter((asset) => asset.type === "investment");
  const warnings = collectWarnings(assets, input.overrides ?? []);
  const onboarding = deriveOnboardingProgress({
    activeMemberCount: activeMembers.length,
    holdingCount: assets.length + liabilities.length,
    hasFireConfig: fireScopeConfig !== null,
    snapshotCount: input.snapshots.length,
  });

  const fireGlance: FireGlance | null =
    fireScopeConfig && fireResult
      ? {
          percentFunded: fireResult.percentFunded,
          coastTickFraction:
            fireResult.coastFireRequired && fireResult.fireNumber.amountMinor > 0
              ? Math.min(
                  1,
                  fireResult.coastFireRequired.amountMinor /
                    fireResult.fireNumber.amountMinor,
                )
              : null,
          isAlreadyAtCoastFire: fireResult.isAlreadyAtCoastFire ?? false,
          isFunded: fireResult.percentFunded >= 100,
          yearsToFire:
            fireProjection?.scenarios.find((s) => s.label === "base")?.yearsToFire ??
            null,
          goalsCount: (input.goals ?? []).length,
          goalsReservedMinor: fireResult.reservedForGoals?.amountMinor ?? 0,
        }
      : null;

  return {
    activeMembers,
    assets,
    dashboard,
    deltas,
    fireGlance,
    fireProjection,
    fireResult,
    fireScopeConfig,
    investmentAssets,
    liabilities,
    onboarding,
    persistence,
    positions: input.positions,
    presentation,
    priceCache: input.priceCache,
    pyramid,
    scopes: input.scopes,
    selectedMemberIds,
    selectedScope,
    selectedView: input.selectedView,
    snapshots: input.snapshots,
    summary,
    today,
    warnings,
    workspace,
  };
}

/** Shape returned by `prepareObjetivosState`. */
export interface ObjetivosGoalView {
  goal: Goal;
  /** Basis points funded (0–10 000), via `goalFundedRatioBps`. */
  fundedRatioBps: number;
  /** Capital reserved in minor units, via `goalReservedMinor`. */
  reservedMinor: number;
  /**
   * True when this goal's deadline is still in the future AND before the FIRE
   * horizon — i.e. its reservation actually reduces the FIRE-eligible total.
   * Uses the same filter as `totalGoalReservationMinor`.
   */
  countsTowardFire: boolean;
  /**
   * How many months this goal delays the FIRE date (PRD #507, S4 #512).
   * Computed by `goalFireDelay` — the 4th reservation consumer. Marginal:
   * measured against the WITHOUT scenario where other goals are already reserved.
   */
  fireDelay: GoalFireDelay;
}

export interface ObjetivosState {
  fireProjection: DashboardState["fireProjection"];
  fireResult: DashboardState["fireResult"];
  fireScopeConfig: DashboardState["fireScopeConfig"];
  /** coastRequired / fireNumber clamped to [0,1]; null when coast data unavailable. */
  coastTickFraction: number | null;
  warnings: DashboardState["warnings"];
  goals: ObjetivosGoalView[];
  /**
   * Coast · Lean · Regular · Fat milestones (PRD #507 N1, #513).
   * Null when no FIRE config is available for the scope.
   */
  fireLevelRail: FireLevel[] | null;
}

/**
 * Pure state for the /objetivos page (PRD #507, S2 #510).
 * Composes `prepareDashboardState` for all FIRE data, then layers per-goal
 * funded/reserved views using the existing `goalFundedRatioBps` /
 * `goalReservedMinor` helpers. No projection math is duplicated here.
 */
export function prepareObjetivosState(
  input: Parameters<typeof prepareDashboardState>[0],
): ObjetivosState {
  const dash = prepareDashboardState(input);

  const { workspace, selectedScope } = dash;
  const assetById = new Map(input.assets.map((a) => [a.id, a]));
  const scopeMemberIds: Set<string> =
    workspace && selectedScope
      ? new Set(resolveScopeMemberIds(workspace, selectedScope.id))
      : new Set();

  const now = input.today ?? new Date().toISOString().slice(0, 10);
  const unitPrices = unitPriceMajorByHoldingId(input.priceCache);
  const fireHorizon = dash.fireScopeConfig
    ? fireReservationHorizon(dash.fireScopeConfig, now)
    : undefined;

  // Per-goal in-horizon reservation map: only goals whose deadline is future + before horizon.
  const goalReservationMap = new Map<string, number>();
  for (const goal of input.goals ?? []) {
    const assignedMinor = dash.fireScopeConfig
      ? assignedHoldingsValueMinor(goal.assetIds, assetById, scopeMemberIds, (asset) =>
          isFireEligibleAsset(asset, dash.fireScopeConfig!),
        )
      : 0;
    const inHorizon =
      goal.deadline >= now && (fireHorizon === undefined || goal.deadline < fireHorizon);
    goalReservationMap.set(
      goal.id,
      inHorizon ? goalReservedMinor(goal.targetAmountMinor, assignedMinor) : 0,
    );
  }
  const totalReservation = [...goalReservationMap.values()].reduce((s, v) => s + v, 0);

  const goals: ObjetivosGoalView[] = (input.goals ?? []).map((goal) => {
    const assignedMinor = assignedHoldingsValueMinor(
      goal.assetIds,
      assetById,
      scopeMemberIds,
    );
    const inHorizon =
      goal.deadline >= now && (fireHorizon === undefined || goal.deadline < fireHorizon);
    const countsTowardFire = inHorizon && (goalReservationMap.get(goal.id) ?? 0) > 0;
    // otherReservationsMinor = total in-horizon reservation minus this goal's share.
    const otherReservationsMinor =
      totalReservation - (goalReservationMap.get(goal.id) ?? 0);
    return {
      goal,
      fundedRatioBps: goalFundedRatioBps(goal.targetAmountMinor, assignedMinor),
      reservedMinor: goalReservedMinor(goal.targetAmountMinor, assignedMinor),
      countsTowardFire,
      fireDelay: dash.fireResult
        ? goalFireDelay({
            context: dash.fireResult.context,
            goal,
            otherReservationsMinor,
            thisGoalReservationMinor: goalReservationMap.get(goal.id) ?? 0,
            now,
            ...(input.contributionPlan
              ? { contributionPlan: input.contributionPlan }
              : {}),
            ...(Object.keys(unitPrices).length > 0
              ? { unitPriceMajorByHoldingId: unitPrices }
              : {}),
          })
        : { kind: "no_effect" as const },
    };
  });

  // fireLevels reads the net eligible + resolved rate straight from the context
  // (#1026), so rail ETAs are coherent with the projection chart and coast by
  // construction — the context carries the SAME net eligible the chart starts from.
  const fireLevelRail = dash.fireResult
    ? fireLevels({
        context: dash.fireResult.context,
        today: now,
        ...(input.contributionPlan ? { contributionPlan: input.contributionPlan } : {}),
        ...(Object.keys(unitPrices).length > 0
          ? { unitPriceMajorByHoldingId: unitPrices }
          : {}),
      })
    : null;

  return {
    coastTickFraction: dash.fireGlance?.coastTickFraction ?? null,
    fireProjection: dash.fireProjection,
    fireResult: dash.fireResult,
    fireScopeConfig: dash.fireScopeConfig,
    warnings: dash.warnings,
    goals,
    fireLevelRail,
  };
}
