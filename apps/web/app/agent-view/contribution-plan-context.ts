import { readExposureCatalogFromControlPlane } from "@web/read-exposure-catalog";
import type { AgentViewReadStore } from "@worthline/db";
import type {
  ContributionPlan,
  ExposureAllocationSlice,
  ExposureDimensionResult,
  FireContext,
  FireGrowthAssumption,
  FireScenario,
  ManualAsset,
  MonthlyContributionAllocation,
  PlannedContribution,
  PlannedContributionAmount,
  ProjectedContributionOccurrence,
} from "@worthline/domain";
import {
  assembleExposureDriftHoldings,
  computeMonthlyContributionAllocation,
  contributionOccurrenceMoneyMinor,
  instrumentOfAsset,
  isContributionMonthKey,
  listScopeOptions,
  projectContributionReconciliation,
  projectExposureDrift,
  projectFireFromContext,
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
  type AgentViewExposureDimension,
  type AgentViewExposureDrift,
  type AgentViewExposureDriftPoint,
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
import {
  catalogProfileMap,
  type ReadExposureCatalog,
  resolveExposureCatalog,
} from "./exposure-catalog";
import { ratioStringFromBps } from "./financial-context";
import { resolveFire } from "./fire-context";
import { deriveOperationPublicId } from "./holding-operations";
import { buildHoldingReturns } from "./returns";
import { publicIdMap, requirePublicId } from "./scope-resolution";
import type { ScopedAgentView } from "./scoped-read";
import { listAgentViewScopes } from "./scopes";

const TRUTH_NOTE =
  "Forecast metadata only. Planned contributions and occurrences are intentions, not executed truth. Confirmed buys, value updates, and net worth remain authoritative via get_operations and get_financial_context.";

const DEFAULT_RECONCILIATION_WINDOW_DAYS = 90;

export interface BuildContributionPlanContextOptions {
  /** `YYYY-MM` month for the allocation view; defaults to the current UTC month. */
  month?: string;
  growthAssumption?: FireGrowthAssumption;
  reconciliationWindowDays?: number;
  asOf?: string;
  /** Global exposure-profile catalog reader (PRD #711 S3); defaults to the control plane. */
  readExposureCatalog?: ReadExposureCatalog;
}

/**
 * Build the contribution-plan MCP surface for a scope (ADR 0041, PRD #553 S5):
 * the recurring plan, monthly allocation, pending/backlog reconciliation, and
 * what-if trajectory. Pure read — forecast never enters net worth or snapshots.
 */
export async function buildContributionPlanContext(
  scoped: ScopedAgentView,
  options: BuildContributionPlanContextOptions,
): Promise<AgentViewContributionPlanContext> {
  const { store } = scoped;
  const today = options.asOf ?? systemClock().today();
  const month = options.month ?? today.slice(0, 7);
  if (!isContributionMonthKey(month)) {
    throw new AgentViewHttpError({
      code: "bad_request",
      details: { month },
      message: "month must be a YYYY-MM calendar month.",
      status: 400,
    });
  }
  const growthAssumption = options.growthAssumption ?? "historical";
  const reconciliationWindowDays =
    options.reconciliationWindowDays ?? DEFAULT_RECONCILIATION_WINDOW_DAYS;

  const scope = await resolveScope(store, scoped.scopeId);
  const internalScopeId = await scoped.internalScopeId();
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

  const { fire } = await resolveFire(scoped);

  const whatIf = await buildWhatIf({
    store,
    plan,
    growthAssumption,
    ...(fire.result === undefined ? {} : { context: fire.result.context }),
    assetById,
    internalScopeId,
    today,
    currency,
    unitPrices,
  });

  const baseYearsToFire = whatIf.scenarios.find(
    (scenario) => scenario.label === "base",
  )?.yearsToFire;
  const exposureDrift = await buildExposureDrift({
    store,
    readExposureCatalog:
      options.readExposureCatalog ?? readExposureCatalogFromControlPlane,
    plan,
    growthAssumption,
    assumedAnnualReturn: fire.result?.context.realReturnUsed ?? 0.05,
    workspace,
    internalScopeId,
    assets,
    assetById,
    today,
    currency,
    unitPrices,
    ...(baseYearsToFire === undefined ? {} : { horizonYears: baseYearsToFire }),
  });

  return {
    object: "contribution_plan_context",
    scope,
    forecast: true,
    truthNote: TRUTH_NOTE,
    status: plan.contributions.length === 0 ? "empty" : "configured",
    contributions: plan.contributions.map((contribution) =>
      toPlannedContribution(contribution, holdingPublicIds, currency, unitPrices, today),
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
    monthlyAllocation: toMonthlyAllocation(
      computeMonthlyContributionAllocation({
        monthKey: month,
        operations,
        plan,
        reconciliations,
        today,
        unitPriceMajorByHoldingId: unitPrices,
      }),
      holdingPublicIds,
      currency,
    ),
    reconciliation: toReconciliation(
      projection,
      { from: reconciliationFromDate, to: reconciliationToDate },
      holdingPublicIds,
      currency,
      unitPrices,
    ),
    whatIf,
    exposureDrift,
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
  today: string,
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
    active:
      contribution.startDate <= today &&
      (contribution.endDate === undefined || contribution.endDate >= today),
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

/**
 * Map the shared monthly-allocation seam (`computeMonthlyContributionAllocation`,
 * PRD #553 S3 — the same derivation /objetivos renders) to the agent-view shape.
 * Unpriced destinations keep a null planned amount plus their planned units and
 * are listed in `missingUnitPriceHoldings` — never silently dropped or guessed.
 */
function toMonthlyAllocation(
  allocation: MonthlyContributionAllocation,
  holdingPublicIds: Map<string, string>,
  currency: string,
): AgentViewMonthlyAllocation {
  const slices: AgentViewMonthlyAllocationSlice[] = allocation.destinations.map(
    (destination) => ({
      destinationHolding: requirePublicId(holdingPublicIds, destination.holdingId),
      plannedAmount:
        destination.plannedMinor === null
          ? null
          : moneyOf(destination.plannedMinor, currency),
      ...(destination.plannedUnits === null
        ? {}
        : { plannedUnits: destination.plannedUnits }),
      executed: moneyOf(destination.executedMinor, currency),
      occurrenceCount: destination.occurrenceCount,
      closedCount: destination.closedCount,
      shareOfMonth:
        destination.plannedMinor === null || allocation.totalPlannedMinor === 0
          ? "0"
          : ratioStringFromBps(
              Math.round(
                (destination.plannedMinor / allocation.totalPlannedMinor) * 10_000,
              ),
            ),
    }),
  );

  return {
    object: "monthly_allocation",
    month: allocation.monthKey,
    totalPlanned: moneyOf(allocation.totalPlannedMinor, currency),
    totalExecuted: moneyOf(allocation.totalExecutedMinor, currency),
    missingUnitPriceHoldings: allocation.unpricedHoldingIds.map((holdingId) =>
      requirePublicId(holdingPublicIds, holdingId),
    ),
    slices,
  };
}

function toReconciliation(
  projection: {
    pending: ProjectedContributionOccurrence[];
    closed: ProjectedContributionOccurrence[];
  },
  window: { from: string; to: string },
  holdingPublicIds: Map<string, string>,
  currency: string,
  unitPrices: Record<string, string>,
): AgentViewContributionReconciliation {
  const pending = projection.pending.map((item) =>
    toOccurrence(item, holdingPublicIds, currency, unitPrices),
  );
  return {
    object: "contribution_reconciliation",
    window,
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
  /** The scope's resolved FIRE context; absent → the scope has no FIRE config. */
  context?: FireContext;
  assetById: Map<string, ManualAsset>;
  internalScopeId: string;
  today: string;
  currency: string;
  unitPrices: Record<string, string>;
}): Promise<AgentViewContributionWhatIf> {
  const { context } = input;
  const assumedAnnualReturn = context?.realReturnUsed ?? 0.05;

  if (context === undefined) {
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

  // #1122: the what-if projects through the single door (plan + growth-assumption
  // mode), so its rate, FIRE number and starting balance all come from the same
  // context as coast + levels + the main projection chart.
  const projection = projectFireFromContext(context, {
    plan: input.plan,
    growthAssumption: input.growthAssumption,
    assumedAnnualReturn,
    holdingAnnualReturnById,
    unitPriceMajorByHoldingId: input.unitPrices,
    todayISO: input.today,
  });

  return {
    object: "contribution_what_if",
    growthAssumption: input.growthAssumption,
    assumedAnnualReturn: assumedAnnualReturn.toString(),
    status: "configured",
    fireNumber: moneyOf(context.fireNumberMinor, input.currency),
    scenarios: projection.scenarios.map((scenario) =>
      toScenario(scenario, input.currency),
    ),
  };
}

async function resolveHoldingAnnualReturns(input: {
  store: AgentViewReadStore;
  plan?: ContributionPlan;
  assetById: Map<string, ManualAsset>;
  internalScopeId: string;
  today: string;
  currency: string;
  assumedAnnualReturn: number;
  holdingIds?: string[];
}): Promise<Record<string, number>> {
  const destinationIds = input.holdingIds ?? [
    ...new Set(input.plan?.contributions.map((item) => item.destinationHoldingId) ?? []),
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

function earliestPlanDate(plan: ContributionPlan, today: string): string {
  const starts = plan.contributions.map((item) => item.startDate).sort();
  return starts[0] ?? today;
}

function addDays(iso: string, days: number): string {
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function moneyOf(amountMinor: number, currency: string): AgentViewMoney {
  return { amountMinor, currency };
}

const DEFAULT_EXPOSURE_DRIFT_HORIZON_YEARS = 20;

async function buildExposureDrift(input: {
  store: AgentViewReadStore;
  readExposureCatalog: ReadExposureCatalog;
  plan: ContributionPlan;
  growthAssumption: FireGrowthAssumption;
  assumedAnnualReturn: number;
  workspace: Awaited<ReturnType<AgentViewReadStore["readWorkspace"]>>;
  internalScopeId: string;
  assets: ManualAsset[];
  assetById: Map<string, ManualAsset>;
  today: string;
  currency: string;
  unitPrices: Record<string, string>;
  horizonYears?: number | null;
}): Promise<AgentViewExposureDrift> {
  if (!input.workspace || input.plan.contributions.length === 0) {
    return {
      object: "exposure_drift",
      growthAssumption: input.growthAssumption,
      assumedAnnualReturn: input.assumedAnnualReturn.toString(),
      status: "empty",
      trajectory: [],
    };
  }

  const scopeOption =
    listScopeOptions(input.workspace).find(
      (scope) => scope.id === input.internalScopeId,
    ) ?? listScopeOptions(input.workspace)[0];
  if (!scopeOption) {
    return {
      object: "exposure_drift",
      growthAssumption: input.growthAssumption,
      assumedAnnualReturn: input.assumedAnnualReturn.toString(),
      status: "empty",
      trajectory: [],
    };
  }

  const [liabilities, investmentMeta, catalogAvailability] = await Promise.all([
    input.store.readLiabilities(),
    input.store.readInvestmentAssetsWithMeta(),
    input.readExposureCatalog(),
  ]);
  // Drift degrades gracefully when the catalog is unavailable: an empty profile
  // set leaves holdings unclassified rather than failing the whole plan surface.
  const exposureProfiles = [
    ...catalogProfileMap(resolveExposureCatalog(catalogAvailability)).values(),
  ];
  const { holdings, profiles: profileMap } = assembleExposureDriftHoldings({
    baseCurrency: input.workspace.baseCurrency,
    workspace: input.workspace,
    scope: scopeOption,
    assets: input.assets,
    liabilities,
    investmentMeta,
    exposureProfiles,
    plan: input.plan,
  });

  const holdingAnnualReturnById = await resolveHoldingAnnualReturns({
    store: input.store,
    plan: input.plan,
    assetById: input.assetById,
    holdingIds: holdings.map((holding) => holding.id),
    internalScopeId: input.internalScopeId,
    today: input.today,
    currency: input.currency,
    assumedAnnualReturn: input.assumedAnnualReturn,
  });
  const maxYears = Math.min(
    60,
    Math.max(1, input.horizonYears ?? DEFAULT_EXPOSURE_DRIFT_HORIZON_YEARS),
  );
  const projection = projectExposureDrift({
    todayISO: input.today,
    baseCurrency: input.workspace.baseCurrency,
    plan: input.plan,
    growthAssumption: input.growthAssumption,
    assumedAnnualReturn: input.assumedAnnualReturn,
    holdingAnnualReturnById,
    unitPriceMajorByHoldingId: input.unitPrices,
    holdings,
    profiles: profileMap,
    maxYears,
  });

  return {
    object: "exposure_drift",
    growthAssumption: input.growthAssumption,
    assumedAnnualReturn: input.assumedAnnualReturn.toString(),
    status: holdings.length === 0 ? "empty" : "configured",
    trajectory: projection.trajectory.map((point) =>
      toExposureDriftPoint(point, input.currency),
    ),
  };
}

function toExposureDriftPoint(
  point: {
    year: number;
    grossAssets: { amountMinor: number; currency: string };
    geography: ExposureDimensionResult;
    assetClass: ExposureDimensionResult;
  },
  currency: string,
): AgentViewExposureDriftPoint {
  return {
    year: point.year,
    grossAssets: moneyOf(point.grossAssets.amountMinor, currency),
    byGeography: toExposureDimension(point.geography),
    byAssetClass: toExposureDimension(point.assetClass),
  };
}

function toExposureDimension(
  dimension: ExposureDimensionResult,
): AgentViewExposureDimension {
  return {
    coverage: {
      classified: moneyOf(
        dimension.coverage.classified.amountMinor,
        dimension.coverage.classified.currency,
      ),
      notApplicable: moneyOf(
        dimension.coverage.notApplicable.amountMinor,
        dimension.coverage.notApplicable.currency,
      ),
      unknown: moneyOf(
        dimension.coverage.unknown.amountMinor,
        dimension.coverage.unknown.currency,
      ),
    },
    slices: dimension.slices.map(toExposureSlice),
  };
}

function toExposureSlice(slice: ExposureAllocationSlice) {
  return {
    key: slice.key,
    value: moneyOf(slice.value.amountMinor, slice.value.currency),
    weight: slice.weight,
  };
}
