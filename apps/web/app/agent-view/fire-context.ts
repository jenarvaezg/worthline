import type { AgentViewReadStore } from "@worthline/db";
import {
  assignedHoldingsValueMinor,
  calculateFireForScope,
  fireReservationHorizon,
  listScopeOptions,
  resolveScopeMemberIds,
  systemClock,
  totalGoalReservationMinor,
} from "@worthline/domain";
import type {
  FireResult,
  FireScopeConfig,
  GoalReservationInput,
  ManualAsset,
  MoneyMinor,
  Workspace,
} from "@worthline/domain";

import {
  AgentViewHttpError,
  type AgentViewFireAssumptions,
  type AgentViewFireConfig,
  type AgentViewFireContext,
  type AgentViewFireExcludedAsset,
  type AgentViewFireResult,
  type AgentViewFireSummary,
  type AgentViewMoney,
  type AgentViewScope,
} from "./contract";
import { ratioStringFromBps } from "./financial-context";
import { publicIdMap, requirePublicId, resolveInternalScopeId } from "./scope-resolution";
import { listAgentViewScopes } from "./scopes";

export interface BuildFireContextOptions {
  /** Public scope ID (`wl_scp_…`) selected by the caller. */
  scopeId: string;
}

/**
 * The FIRE facts a scope resolves to (PRD #328, #340): its config and computed
 * result when configured, plus the eligible/excluded assets the result rests on.
 * Shared by the full `fire-context` endpoint and the compact main-context FIRE
 * summary, so both read the same numbers.
 */
interface ResolvedFire {
  config: FireScopeConfig | undefined;
  result: FireResult | undefined;
  currency: string;
}

/**
 * Resolve a scope and read its FIRE facts with no side effects (PRD #328, #340).
 * A missing scope is a 404; a scope with no FIRE config resolves to an
 * `unconfigured` state — never fabricated figures. Current-only: the caller is
 * responsible for rejecting historical requests before this point.
 */
async function resolveFire(
  store: AgentViewReadStore,
  publicScopeId: string,
): Promise<{ scope: AgentViewScope; fire: ResolvedFire }> {
  const workspace = await store.readWorkspace();

  if (!workspace) {
    throw unknownScope();
  }

  const scope = (await listAgentViewScopes(store)).find(
    (candidate) => candidate.id === publicScopeId,
  );

  if (!scope) {
    throw unknownScope();
  }

  const internalScopeId = await resolveInternalScopeId(store, publicScopeId);
  const scopeOption = listScopeOptions(workspace).find(
    (option) => option.id === internalScopeId,
  );

  if (!scopeOption) {
    throw new AgentViewHttpError({
      code: "internal_error",
      message: "Agent view scope is not resolvable.",
      status: 500,
    });
  }

  const config = (await store.readFireConfig())[internalScopeId];
  let result: FireResult | undefined;

  if (config !== undefined) {
    const assets = await store.readAssets();
    const reservedForGoalsMinor = await goalReservationMinor(
      store,
      workspace,
      internalScopeId,
      config,
      assets,
    );
    result = calculateFireForScope(
      config,
      assets,
      workspace,
      internalScopeId,
      reservedForGoalsMinor,
    );
  }

  return {
    fire: { config, currency: workspace.baseCurrency, result },
    scope,
  };
}

/**
 * Capital reserved by goals against the scope's FIRE eligibility (PRD #421,
 * #426): each goal's `min(target, scope-weighted assigned value)` summed for the
 * goals due before the FIRE horizon. Returns 0 when the scope has no goals.
 */
export async function goalReservationMinor(
  store: AgentViewReadStore,
  workspace: Workspace,
  internalScopeId: string,
  config: FireScopeConfig,
  assets: ManualAsset[],
): Promise<number> {
  const goals = await store.readGoals(internalScopeId);

  if (goals.length === 0) {
    return 0;
  }

  const now = systemClock().today();
  const scopeMemberIds = new Set(resolveScopeMemberIds(workspace, internalScopeId));
  const assetById = new Map(assets.map((asset) => [asset.id, asset]));
  const inputs: GoalReservationInput[] = goals.map((goal) => ({
    targetAmountMinor: goal.targetAmountMinor,
    deadline: goal.deadline,
    assignedValueMinor: assignedHoldingsValueMinor(
      goal.assetIds,
      assetById,
      scopeMemberIds,
    ),
  }));

  return totalGoalReservationMinor(inputs, now, fireReservationHorizon(config, now));
}

/**
 * Assemble the full FIRE context for a scope (PRD #328, #340): config, computed
 * result, the scope-weighted eligible total, the excluded assets with their
 * reason, the assumptions, and — when unconfigured — a `missing_configuration`
 * quality signal. Reads only; never writes FIRE settings (ADR 0023).
 */
export async function buildFireContext(
  store: AgentViewReadStore,
  options: BuildFireContextOptions,
): Promise<AgentViewFireContext> {
  const { scope, fire } = await resolveFire(store, options.scopeId);

  if (fire.config === undefined || fire.result === undefined) {
    return {
      eligibleAssetsTotal: zero(fire.currency),
      excludedAssets: [],
      qualitySignals: [
        {
          category: "missing_configuration",
          message: "This scope has no FIRE configuration.",
        },
      ],
      scope,
      status: "unconfigured",
    };
  }

  const config = fire.config;
  const result = fire.result;
  const assumptions = toAssumptions(config, fire.currency);

  return {
    assumptions,
    config: toConfig(config, fire.currency),
    eligibleAssetsTotal: money(result.eligibleAssets),
    excludedAssets: await toExcludedAssets(store, result),
    qualitySignals: [],
    result: toResult(result),
    scope,
    status: "configured",
  };
}

/**
 * The compact FIRE summary folded into the main financial context (PRD #328,
 * #340): status-only when unconfigured, otherwise the headline figures plus a
 * compact assumptions block. Reuses the same resolution as the full endpoint.
 */
export async function buildFireSummary(
  store: AgentViewReadStore,
  publicScopeId: string,
): Promise<AgentViewFireSummary> {
  const { fire } = await resolveFire(store, publicScopeId);

  if (fire.config === undefined || fire.result === undefined) {
    return { status: "unconfigured" };
  }

  const result = fire.result;

  return {
    assumptions: toAssumptions(fire.config, fire.currency),
    eligibleAssets: money(result.eligibleAssets),
    fireNumber: money(result.fireNumber),
    gap: gapOf(result),
    progressRatio: progressRatioOf(result),
    status: "configured",
  };
}

function toConfig(config: FireScopeConfig, currency: string): AgentViewFireConfig {
  return {
    expectedRealReturn: rateString(config.expectedRealReturn),
    monthlySpending: moneyOf(config.monthlySpendingMinor, currency),
    safeWithdrawalRate: rateString(config.safeWithdrawalRate),
    ...(config.currentAge === undefined ? {} : { currentAge: config.currentAge }),
    ...(config.targetRetirementAge === undefined
      ? {}
      : { targetRetirementAge: config.targetRetirementAge }),
    ...(config.monthlySavingsCapacityMinor === undefined
      ? {}
      : {
          monthlySavingsCapacity: moneyOf(config.monthlySavingsCapacityMinor, currency),
        }),
  };
}

function toAssumptions(
  config: FireScopeConfig,
  currency: string,
): AgentViewFireAssumptions {
  return {
    expectedRealReturn: rateString(config.expectedRealReturn),
    monthlySpending: moneyOf(config.monthlySpendingMinor, currency),
    safeWithdrawalRate: rateString(config.safeWithdrawalRate),
  };
}

function toResult(result: FireResult): AgentViewFireResult {
  return {
    eligibleAssets: money(result.eligibleAssets),
    fireNumber: money(result.fireNumber),
    gap: gapOf(result),
    progressRatio: progressRatioOf(result),
    ...(result.reservedForGoals && result.reservedForGoals.amountMinor > 0
      ? { reservedForGoals: money(result.reservedForGoals) }
      : {}),
    ...(result.coastFireRequired === undefined
      ? {}
      : { coastFireRequired: money(result.coastFireRequired) }),
    ...(result.coastFireAge === undefined ? {} : { coastFireAge: result.coastFireAge }),
    ...(result.isAlreadyAtCoastFire === undefined
      ? {}
      : { isAlreadyAtCoastFire: result.isAlreadyAtCoastFire }),
  };
}

async function toExcludedAssets(
  store: AgentViewReadStore,
  result: FireResult,
): Promise<AgentViewFireExcludedAsset[]> {
  const holdingPublicIds = publicIdMap(await store.readPublicIds(), "holding");

  return result.excludedAssets.map((excluded) => ({
    holding: {
      id: requirePublicId(holdingPublicIds, excluded.id),
      label: excluded.name,
      object: "holding" as const,
    },
    reason: excluded.reason,
  }));
}

/** `fireNumber − eligibleAssets`, signed (negative once over-funded). */
function gapOf(result: FireResult): AgentViewMoney {
  return moneyOf(
    result.fireNumber.amountMinor - result.eligibleAssets.amountMinor,
    result.fireNumber.currency,
  );
}

/**
 * `eligibleAssets / fireNumber` as an exact non-negative decimal string —
 * exceeds `1` once over-funded (never clamped, so over-funding stays visible)
 * (PRD #328). Integer-only basis-point math, so no float artefacts; `0` when the
 * FIRE number is zero (an unreachable config, but a divide-by-zero would leak).
 */
function progressRatioOf(result: FireResult): string {
  const fireNumberMinor = result.fireNumber.amountMinor;

  if (fireNumberMinor <= 0) {
    return "0";
  }

  const bps = Math.round((result.eligibleAssets.amountMinor * 10_000) / fireNumberMinor);
  return ratioStringFromBps(bps);
}

/**
 * Format a stored FIRE rate (a JS number like `0.04`) as a decimal string.
 * `Number.prototype.toString` already yields the shortest exact decimal, so a
 * stored `0.04` round-trips to `"0.04"` with no float noise.
 */
function rateString(rate: number): string {
  return rate.toString();
}

function money(value: MoneyMinor): AgentViewMoney {
  return { amountMinor: value.amountMinor, currency: value.currency };
}

function moneyOf(amountMinor: number, currency: string): AgentViewMoney {
  return { amountMinor, currency };
}

function zero(currency: string): AgentViewMoney {
  return { amountMinor: 0, currency };
}

function unknownScope(): AgentViewHttpError {
  return new AgentViewHttpError({
    code: "not_found",
    message: "Unknown scope.",
    status: 404,
  });
}
