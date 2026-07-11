import type { AgentViewReadStore } from "@worthline/db";
import type {
  ContributionOccurrence,
  ContributionPlan,
  FireGrowthAssumption,
  FireScenario,
  ManualAsset,
  PlannedContribution,
  PlannedContributionAmount,
  ProjectedContributionOccurrence,
} from "@worthline/domain";
import {
  contributionOccurrenceMoneyMinor,
  expandContributionPlan,
  instrumentOfAsset,
  projectContributionReconciliation,
  projectFireWithContributionPlan,
  resolveHoldingAnnualReturnForProjection,
  resolveMonthlySavingsCapacityForFire,
  systemClock,
  unitPriceMajorByHoldingId,
} from "@worthline/domain";

import {
  type AgentViewContributionOccurrence,
  type AgentViewContributionPlanContext,
  type AgentViewContributionReconciliation,
  type AgentViewContributionWhatIf,
  type AgentViewFireScenario,
  AgentViewHttpError,
  type AgentViewMoney,
  type AgentViewMonthlyAllocation,
  type AgentViewMonthlyAllocationSlice,
  type AgentViewPlannedContribution,
  type AgentViewReturns,
  type AgentViewScope,
} from "./contract";
import { derivePublicId } from "./derived-id";
import { ratioStringFromBps } from "./financial-context";
import { resolveFire } from "./fire-context";
import { deriveOperationPublicId } from "./holding-operations";
import { buildHoldingReturns } from "./returns";
import { publicIdMap, requirePublicId, resolveInternalScopeId } from "./scope-resolution";
import { listAgentViewScopes } from "./scopes";

const TRUTH_NOTE =
  "Forecast metadata only. Planned contributions and occurrences are intentions, not executed truth. Confirmed buys, value updates, and net worth remain authoritative via get_operations and get_financial_context.";

const DEFAULT_RECONCILIATION_WINDOW_DAYS = 90;

export interface BuildContributionPlanContextOptions {
  scopeId: string;
  /** `YYYY-MM` month for the allocation view; defaults to the current UTC month. */
  month?: string;
  growthAssumption?: FireGrowthAssumption;
  reconciliationWindowDays?: number;
  asOf?: string;
}

/**
 * Build the contribution-plan MCP surface for a scope (ADR 0041, PRD #553 S5):
 * the recurring plan, monthly allocation, pending/backlog reconciliation, and
 * what-if trajectory. Pure read — forecast never enters net worth or snapshots.
 */
export async function buildContributionPlanContext(
  store: AgentViewReadStore,
  options: BuildContributionPlanContextOptions,
): Promise<AgentViewContributionPlanContext> {
  const today = options.asOf ?? systemClock().today();
  const month = options.month ?? today.slice(0, 7);
  const growthAssumption = options.growthAssumption ?? "historical";
  const reconciliationWindowDays =
    options.reconciliationWindowDays ?? DEFAULT_RECONCILIATION_WINDOW_DAYS;

  const scope = await resolveScope(store, options.scopeId);
  const internalScopeId = await resolveInternalScopeId(store, options.scopeId);
  const workspace = await store.readWorkspace();
  const currency = workspace?.baseCurrency ?? "EUR";

  const [plan, reconciliations, priceCache, fireConfig, assets] = await Promise.all([
    store.readContributionPlan(internalScopeId),
    store.readContributionReconciliations(internalScopeId),
    store.readAllPriceCacheEntries(),
    store.readFireConfig(),
    store.readAssets(),
  ]);

  const unitPrices = unitPriceMajorByHoldingId(priceCache);
  const holdingPublicIds = publicIdMap(await store.readPublicIds(), "holding");
  const assetById = new Map(assets.map((asset) => [asset.id, asset]));

  const scopeConfig = fireConfig[internalScopeId];
  const monthlyCapacity = resolveMonthlySavingsCapacityForFire(
    plan,
    scopeConfig ?? { monthlySpendingMinor: 0, safeWithdrawalRate: 0.04 },
    today,
    unitPrices,
  );

  const operations = await readInvestmentOperations(store, assets);
  const reconciliationFromDate = earliestPlanDate(plan, today);
  const reconciliationToDate = addDays(today, reconciliationWindowDays);

  const projection = projectContributionReconciliation({
    plan,
    fromDate: reconciliationFromDate,
    toDate: reconciliationToDate,
    today,
    reconciliations,
    operations,
  });

  const { fire } = await resolveFire(store, options.scopeId);

  return {
    object: "contribution_plan_context",
    scope,
    forecast: true,
    truthNote: TRUTH_NOTE,
    status: plan.contributions.length === 0 ? "empty" : "configured",
    contributions: plan.contributions.map((contribution) =>
      toPlannedContribution(contribution, holdingPublicIds, currency, unitPrices),
    ),
    monthlySavingsCapacity: {
      amount: moneyOf(monthlyCapacity.capacityMinor, currency),
      source: monthlyCapacity.source,
      ...(monthlyCapacity.missingUnitPriceHoldingIds === undefined
        ? {}
        : {
            missingUnitPriceHoldings: monthlyCapacity.missingUnitPriceHoldingIds.map(
              (holdingId) => requirePublicId(holdingPublicIds, holdingId),
            ),
          }),
    },
    monthlyAllocation: buildMonthlyAllocation(
      plan,
      month,
      holdingPublicIds,
      currency,
      unitPrices,
    ),
    reconciliation: toReconciliation(projection, holdingPublicIds, currency, unitPrices),
    whatIf: await buildWhatIf({
      store,
      plan,
      growthAssumption,
      fireConfigured: fire.config !== undefined && fire.result !== undefined,
      ...(fire.result === undefined
        ? {}
        : {
            fireNumberMinor: fire.result.fireNumber.amountMinor,
            startingEligibleMinor: fire.result.eligibleAssets.amountMinor,
            expectedRealReturn:
              fire.result.realReturnUsed ?? fire.config?.expectedRealReturn ?? 0.05,
          }),
      ...(fire.config?.currentAge === undefined
        ? {}
        : { currentAge: fire.config.currentAge }),
      assetById,
      internalScopeId,
      today,
      currency,
      unitPrices,
    }),
  };
}

async function resolveScope(
  store: AgentViewReadStore,
  publicScopeId: string,
): Promise<AgentViewScope> {
  const scope = (await listAgentViewScopes(store)).find(
    (candidate) => candidate.id === publicScopeId,
  );
  if (!scope) {
    throw new AgentViewHttpError({
      code: "not_found",
      message: "Unknown scope.",
      status: 404,
    });
  }
  return scope;
}

function toPlannedContribution(
  contribution: PlannedContribution,
  holdingPublicIds: Map<string, string>,
  currency: string,
  unitPrices: Record<string, string>,
): AgentViewPlannedContribution {
  return {
    object: "planned_contribution",
    id: derivePublicId("cpc", contribution.id),
    destinationHolding: requirePublicId(
      holdingPublicIds,
      contribution.destinationHoldingId,
    ),
    amount: toAmount(
      contribution.amount,
      contribution.destinationHoldingId,
      currency,
      unitPrices,
    ),
    cadence: contribution.cadence,
    startDate: contribution.startDate,
    ...(contribution.endDate === undefined ? {} : { endDate: contribution.endDate }),
  };
}

function toAmount(
  amount: PlannedContributionAmount,
  destinationHoldingId: string,
  currency: string,
  unitPrices: Record<string, string>,
): AgentViewPlannedContribution["amount"] {
  if (amount.mode === "money") {
    return { mode: "money", value: moneyOf(amount.value, currency) };
  }
  const moneyMinor = contributionOccurrenceMoneyMinor(
    { destinationHoldingId, amount },
    unitPrices,
  );
  return {
    mode: "units",
    value: amount.value,
    ...(moneyMinor === null ? {} : { estimatedValue: moneyOf(moneyMinor, currency) }),
  };
}

function buildMonthlyAllocation(
  plan: ContributionPlan,
  month: string,
  holdingPublicIds: Map<string, string>,
  currency: string,
  unitPrices: Record<string, string>,
): AgentViewMonthlyAllocation {
  const { from, to } = monthBounds(month);
  const occurrences = expandContributionPlan(plan, from, to);
  const byHolding = new Map<string, number>();

  for (const occurrence of occurrences) {
    const moneyMinor = occurrenceMoneyMinor(occurrence, unitPrices);
    if (moneyMinor === null) {
      continue;
    }
    byHolding.set(
      occurrence.destinationHoldingId,
      (byHolding.get(occurrence.destinationHoldingId) ?? 0) + moneyMinor,
    );
  }

  const totalPlanned = [...byHolding.values()].reduce((sum, value) => sum + value, 0);
  const slices: AgentViewMonthlyAllocationSlice[] = [...byHolding.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([holdingId, amountMinor]) => ({
      destinationHolding: requirePublicId(holdingPublicIds, holdingId),
      plannedAmount: moneyOf(amountMinor, currency),
      shareOfMonth:
        totalPlanned === 0
          ? "0"
          : ratioStringFromBps(Math.round((amountMinor / totalPlanned) * 10_000)),
    }));

  return {
    object: "monthly_allocation",
    month,
    totalPlanned: moneyOf(totalPlanned, currency),
    slices,
  };
}

function toReconciliation(
  projection: {
    pending: ProjectedContributionOccurrence[];
    closed: ProjectedContributionOccurrence[];
  },
  holdingPublicIds: Map<string, string>,
  currency: string,
  unitPrices: Record<string, string>,
): AgentViewContributionReconciliation {
  const pending = projection.pending.map((item) =>
    toOccurrence(item, holdingPublicIds, currency, unitPrices),
  );
  return {
    object: "contribution_reconciliation",
    pending,
    backlog: pending.filter((item) => item.backlog),
    closed: projection.closed.map((item) =>
      toOccurrence(item, holdingPublicIds, currency, unitPrices),
    ),
  };
}

function toOccurrence(
  item: ProjectedContributionOccurrence,
  holdingPublicIds: Map<string, string>,
  currency: string,
  unitPrices: Record<string, string>,
): AgentViewContributionOccurrence {
  const { occurrence, summary } = item;
  return {
    object: "contribution_occurrence",
    id: derivePublicId("cpo", occurrence.id),
    plannedContributionId: derivePublicId("cpc", occurrence.contributionId),
    destinationHolding: requirePublicId(
      holdingPublicIds,
      occurrence.destinationHoldingId,
    ),
    plannedDate: occurrence.plannedDate,
    amount: toAmount(
      occurrence.amount,
      occurrence.destinationHoldingId,
      currency,
      unitPrices,
    ),
    state: item.state,
    backlog: item.backlog,
    linkedOperations: item.operationIds.map((operationId) =>
      deriveOperationPublicId(operationId),
    ),
    progress:
      summary.mode === "money"
        ? {
            mode: "money",
            planned: moneyOf(summary.plannedMinor, currency),
            executed: moneyOf(summary.executedMinor, currency),
            delta: moneyOf(summary.deltaMinor, currency),
          }
        : {
            mode: "units",
            plannedUnits: summary.plannedUnits,
            executedUnits: summary.executedUnits,
            deltaUnits: summary.deltaUnits,
            actualCash: moneyOf(summary.actualCashMinor, currency),
          },
  };
}

async function buildWhatIf(input: {
  store: AgentViewReadStore;
  plan: ContributionPlan;
  growthAssumption: FireGrowthAssumption;
  fireConfigured: boolean;
  fireNumberMinor?: number;
  startingEligibleMinor?: number;
  expectedRealReturn?: number;
  currentAge?: number;
  assetById: Map<string, ManualAsset>;
  internalScopeId: string;
  today: string;
  currency: string;
  unitPrices: Record<string, string>;
}): Promise<AgentViewContributionWhatIf> {
  const assumedAnnualReturn = input.expectedRealReturn ?? 0.05;

  if (
    !input.fireConfigured ||
    input.fireNumberMinor === undefined ||
    input.startingEligibleMinor === undefined
  ) {
    return {
      object: "contribution_what_if",
      growthAssumption: input.growthAssumption,
      assumedAnnualReturn: assumedAnnualReturn.toString(),
      status: "unconfigured",
      scenarios: [],
    };
  }

  const holdingAnnualReturnById = await resolveHoldingAnnualReturns({
    store: input.store,
    plan: input.plan,
    assetById: input.assetById,
    internalScopeId: input.internalScopeId,
    today: input.today,
    currency: input.currency,
    assumedAnnualReturn,
  });

  const projection = projectFireWithContributionPlan({
    startingEligibleMinor: input.startingEligibleMinor,
    expectedRealReturn: assumedAnnualReturn,
    fireNumberMinor: input.fireNumberMinor,
    todayISO: input.today,
    plan: input.plan,
    growthAssumption: input.growthAssumption,
    assumedAnnualReturn,
    holdingAnnualReturnById,
    unitPriceMajorByHoldingId: input.unitPrices,
    ...(input.currentAge === undefined ? {} : { currentAge: input.currentAge }),
  });

  return {
    object: "contribution_what_if",
    growthAssumption: input.growthAssumption,
    assumedAnnualReturn: assumedAnnualReturn.toString(),
    status: "configured",
    fireNumber: moneyOf(input.fireNumberMinor, input.currency),
    scenarios: projection.scenarios.map((scenario) =>
      toScenario(scenario, input.currency),
    ),
  };
}

async function resolveHoldingAnnualReturns(input: {
  store: AgentViewReadStore;
  plan: ContributionPlan;
  assetById: Map<string, ManualAsset>;
  internalScopeId: string;
  today: string;
  currency: string;
  assumedAnnualReturn: number;
}): Promise<Record<string, number>> {
  const destinationIds = [
    ...new Set(input.plan.contributions.map((item) => item.destinationHoldingId)),
  ];
  const byId: Record<string, number> = {};

  for (const holdingId of destinationIds) {
    const asset = input.assetById.get(holdingId);
    if (!asset || asset.type !== "investment") {
      byId[holdingId] = input.assumedAnnualReturn;
      continue;
    }

    const operations = await input.store.readOperations(holdingId);
    const returns = await buildHoldingReturns({
      store: input.store,
      assetId: holdingId,
      currency: input.currency,
      currentValueMinor: asset.currentValue.amountMinor,
      instrument: instrumentOfAsset(asset),
      operations,
      snapshotScopeId: input.internalScopeId,
      valuationDate: input.today,
    });

    byId[holdingId] = annualReturnFromAgentViewReturns(
      returns,
      input.assumedAnnualReturn,
    );
  }

  return byId;
}

function annualReturnFromAgentViewReturns(
  returns: AgentViewReturns | null,
  assumedAnnualReturn: number,
): number {
  if (returns === null) {
    return assumedAnnualReturn;
  }

  return resolveHoldingAnnualReturnForProjection(
    {
      kind: "market",
      totalGain: {
        amountMinor: returns.simple.totalGain.amountMinor,
        currency: returns.simple.totalGain.currency,
      },
      totalReturnRatio:
        returns.simple.totalReturnRatio === null
          ? null
          : Number(returns.simple.totalReturnRatio),
      annualized: returns.simple.annualized,
      cagr: returns.simple.cagr === null ? null : Number(returns.simple.cagr),
      irr: {
        rate:
          returns.moneyWeighted.rate === null ? null : Number(returns.moneyWeighted.rate),
        reason: returns.moneyWeighted.reason,
      },
      twr: {
        rate:
          returns.timeWeighted.rate === null ? null : Number(returns.timeWeighted.rate),
        annualizedRate:
          returns.timeWeighted.annualizedRate === null
            ? null
            : Number(returns.timeWeighted.annualizedRate),
        annualized: returns.timeWeighted.annualized,
        startDate: returns.timeWeighted.startDate,
        endDate: returns.timeWeighted.endDate,
        spanDays: 0,
        reason: returns.timeWeighted.reason,
      },
      realizedPnl: returns.simple.realizedGain ?? null,
      unrealizedPnl: returns.simple.unrealizedGain ?? null,
      caveats: [],
    },
    assumedAnnualReturn,
  );
}

function toScenario(scenario: FireScenario, currency: string): AgentViewFireScenario {
  const money = (amountMinor: number): AgentViewMoney => ({ amountMinor, currency });

  return {
    label: scenario.label,
    annualReturn: scenario.annualReturn.toString(),
    yearsToFire: scenario.yearsToFire,
    ageAtFire: scenario.ageAtFire,
    finalEligible: money(scenario.finalEligibleMinor),
    totalContributed: money(scenario.totalContributedMinor),
    trajectory: scenario.trajectory.map((point) => ({
      year: point.year,
      eligible: money(point.eligibleMinor),
    })),
  };
}

async function readInvestmentOperations(
  store: AgentViewReadStore,
  assets: ManualAsset[],
) {
  return (
    await Promise.all(
      assets
        .filter((asset) => asset.type === "investment")
        .map((asset) => store.readOperations(asset.id)),
    )
  ).flat();
}

function occurrenceMoneyMinor(
  occurrence: ContributionOccurrence,
  unitPrices: Record<string, string>,
): number | null {
  return contributionOccurrenceMoneyMinor(occurrence, unitPrices);
}

function earliestPlanDate(plan: ContributionPlan, today: string): string {
  const starts = plan.contributions.map((item) => item.startDate).sort();
  return starts[0] ?? today;
}

function monthBounds(month: string): { from: string; to: string } {
  const [yearRaw, monthRaw] = month.split("-");
  const year = Number(yearRaw);
  const mon = Number(monthRaw);
  const from = `${month}-01`;
  const lastDay = new Date(Date.UTC(year, mon, 0)).getUTCDate();
  const to = `${month}-${String(lastDay).padStart(2, "0")}`;
  return { from, to };
}

function addDays(iso: string, days: number): string {
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function moneyOf(amountMinor: number, currency: string): AgentViewMoney {
  return { amountMinor, currency };
}
