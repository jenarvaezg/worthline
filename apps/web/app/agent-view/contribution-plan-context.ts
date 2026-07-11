import type { AgentViewReadStore } from "@worthline/db";
import type {
  ContributionPlan,
  ContributionProgressSummary,
  FireGrowthAssumption,
  Instrument,
  InvestmentOperation,
  MonthlyAllocationView,
  PlannedContribution,
  ProjectedContributionOccurrence,
} from "@worthline/domain";
import {
  contributionPendingWindow,
  deriveMonthlyAllocation,
  instrumentOfAsset,
  investmentReturnsById,
  projectContributionReconciliation,
  projectFireWithContributionPlan,
  resolveHoldingAnnualReturnForProjection,
  systemClock,
  unitPriceMajorByHoldingId,
} from "@worthline/domain";

import type {
  AgentViewContributionAmount,
  AgentViewContributionPendingOccurrence,
  AgentViewContributionPlan,
  AgentViewContributionProgress,
  AgentViewContributionWhatIf,
  AgentViewMoney,
  AgentViewMonthlyAllocation,
  AgentViewPlannedContribution,
} from "./contract";
import { derivePublicId } from "./derived-id";
import { resolveFire } from "./fire-context";
import { toAgentViewFireScenario } from "./fire-projection-context";
import { deriveOperationPublicId } from "./holding-operations";
import { publicIdMap, requirePublicId, resolveInternalScopeId } from "./scope-resolution";

export interface BuildContributionPlanOptions {
  /** Growth toggle for the what-if; defaults to `historical` (ADR 0041). */
  growthAssumption?: FireGrowthAssumption;
}

/**
 * Assemble a scope's contribution plan for `get_contribution_plan` (#559, ADR
 * 0041): the plan rows, the forecast monthly allocation, the unconfirmed
 * pending/backlog occurrences, and the what-if trajectory. Everything here is a
 * FORECAST layer over the FIRE/plan config — reads only, no figure the
 * net-worth math consumes, and reconciliation truth is only ever joined from
 * explicit user links (`projectContributionReconciliation` never guesses).
 */
export async function buildContributionPlan(
  store: AgentViewReadStore,
  publicScopeId: string,
  options: BuildContributionPlanOptions = {},
): Promise<AgentViewContributionPlan> {
  const growthAssumption = options.growthAssumption ?? "historical";
  const { scope, fire } = await resolveFire(store, publicScopeId);
  const currency = fire.currency;
  const internalScopeId = await resolveInternalScopeId(store, publicScopeId);
  const plan = await store.readContributionPlan(internalScopeId);
  const priceCache = await store.readAllPriceCacheEntries();
  const unitPrices = unitPriceMajorByHoldingId(priceCache);
  const today = systemClock().today();
  const holdingPublicIds = publicIdMap(await store.readPublicIds(), "holding");
  const holdingPublicId = (internalId: string): string =>
    requirePublicId(holdingPublicIds, internalId);

  const allocation = deriveMonthlyAllocation(plan, today, unitPrices);
  const operationsByAsset = await readDestinationOperations(store, plan);
  const pendingWindow = contributionPendingWindow(plan, today);
  const projection = projectContributionReconciliation({
    fromDate: pendingWindow.from,
    operations: [...operationsByAsset.values()].flat(),
    plan,
    reconciliations: await store.readContributionReconciliations(internalScopeId),
    toDate: pendingWindow.to,
    today,
  });

  return {
    basis: "forecast",
    contributions: plan.contributions.map((row) =>
      toContribution(row, today, currency, holdingPublicId),
    ),
    monthlyAllocation: toMonthlyAllocation(allocation, currency, holdingPublicId),
    object: "contribution_plan",
    pending: projection.pending.map((item) =>
      toPendingOccurrence(item, currency, holdingPublicId),
    ),
    pendingWindow,
    scope,
    status: plan.contributions.length === 0 ? "empty" : "configured",
    whatIf: await buildWhatIf(store, {
      currency,
      fire,
      growthAssumption,
      operationsByAsset,
      plan,
      today,
      unitPrices,
    }),
  };
}

/**
 * The operations of each distinct destination holding, keyed by internal asset
 * id. Linked operations always belong to the stored destination (the write path
 * asserts it), so this bounded read is sufficient for reconciliation progress.
 */
async function readDestinationOperations(
  store: AgentViewReadStore,
  plan: ContributionPlan,
): Promise<Map<string, InvestmentOperation[]>> {
  const destinationIds = [
    ...new Set(plan.contributions.map((row) => row.destinationHoldingId)),
  ];
  return new Map(
    await Promise.all(
      destinationIds.map(
        async (assetId): Promise<[string, InvestmentOperation[]]> => [
          assetId,
          await store.readOperations(assetId),
        ],
      ),
    ),
  );
}

function toContribution(
  row: PlannedContribution,
  today: string,
  currency: string,
  holdingPublicId: (internalId: string) => string,
): AgentViewPlannedContribution {
  return {
    active: row.startDate <= today && (row.endDate === undefined || row.endDate >= today),
    amount: toAmount(row.amount, currency),
    cadence: row.cadence,
    destinationHolding: holdingPublicId(row.destinationHoldingId),
    id: derivePublicId("pcn", row.id),
    object: "planned_contribution",
    startDate: row.startDate,
    ...(row.endDate === undefined ? {} : { endDate: row.endDate }),
  };
}

function toAmount(
  amount: PlannedContribution["amount"],
  currency: string,
): AgentViewContributionAmount {
  if (amount.mode === "money") {
    return { mode: "money", money: { amountMinor: amount.value, currency } };
  }
  return { mode: "units", units: amount.value };
}

function toMonthlyAllocation(
  allocation: MonthlyAllocationView,
  currency: string,
  holdingPublicId: (internalId: string) => string,
): AgentViewMonthlyAllocation {
  return {
    lines: allocation.lines.map((line) => ({
      destinationHolding: holdingPublicId(line.destinationHoldingId),
      incomplete: line.incomplete,
      monthly: { amountMinor: line.monthlyMinor, currency },
    })),
    missingUnitPriceHoldings: allocation.missingUnitPriceHoldingIds.map(holdingPublicId),
    total: { amountMinor: allocation.totalMinor, currency },
  };
}

function toPendingOccurrence(
  item: ProjectedContributionOccurrence,
  currency: string,
  holdingPublicId: (internalId: string) => string,
): AgentViewContributionPendingOccurrence {
  return {
    backlog: item.backlog,
    contribution: derivePublicId("pcn", item.occurrence.contributionId),
    destinationHolding: holdingPublicId(item.occurrence.destinationHoldingId),
    id: derivePublicId("pco", item.occurrence.id),
    object: "contribution_occurrence",
    operations: item.operationIds.map(deriveOperationPublicId),
    plannedDate: item.occurrence.plannedDate,
    progress: toProgress(item.summary, currency),
    // The pending list carries only unconfirmed states by construction.
    state: item.state === "partial" ? "partial" : "pending",
  };
}

function toProgress(
  summary: ContributionProgressSummary,
  currency: string,
): AgentViewContributionProgress {
  const money = (amountMinor: number): AgentViewMoney => ({ amountMinor, currency });
  if (summary.mode === "money") {
    return {
      delta: money(summary.deltaMinor),
      executed: money(summary.executedMinor),
      mode: "money",
      planned: money(summary.plannedMinor),
    };
  }
  return {
    deltaUnits: summary.deltaUnits,
    executedCash: money(summary.actualCashMinor),
    executedUnits: summary.executedUnits,
    mode: "units",
    plannedUnits: summary.plannedUnits,
  };
}

/**
 * The what-if trajectory under the plan (S4 engine, first consumer #559).
 * `historical` growth resolves each destination's measured return (IRR-first
 * here — the agent view reads no monthly closes for this) and falls back to the
 * scope's assumed rate; `flat` applies zero appreciation. Unconfigured without
 * a FIRE config — no figures invented.
 */
async function buildWhatIf(
  store: AgentViewReadStore,
  input: {
    currency: string;
    fire: Awaited<ReturnType<typeof resolveFire>>["fire"];
    growthAssumption: FireGrowthAssumption;
    operationsByAsset: Map<string, InvestmentOperation[]>;
    plan: ContributionPlan;
    today: string;
    unitPrices: Record<string, string>;
  },
): Promise<AgentViewContributionWhatIf> {
  const { config, result } = input.fire;
  if (config === undefined || result === undefined) {
    return {
      growthAssumption: input.growthAssumption,
      scenarios: [],
      status: "unconfigured",
    };
  }

  const assumedAnnualReturn = result.realReturnUsed ?? config.expectedRealReturn ?? 0.05;
  const holdingAnnualReturnById =
    input.growthAssumption === "historical"
      ? await destinationAnnualReturns(store, input, assumedAnnualReturn)
      : undefined;

  const projection = projectFireWithContributionPlan({
    assumedAnnualReturn,
    expectedRealReturn: assumedAnnualReturn,
    fireNumberMinor: result.fireNumber.amountMinor,
    growthAssumption: input.growthAssumption,
    plan: input.plan,
    startingEligibleMinor: result.eligibleAssets.amountMinor,
    todayISO: input.today,
    unitPriceMajorByHoldingId: input.unitPrices,
    ...(config.currentAge === undefined ? {} : { currentAge: config.currentAge }),
    ...(holdingAnnualReturnById === undefined ? {} : { holdingAnnualReturnById }),
  });

  return {
    assumedAnnualReturn: assumedAnnualReturn.toString(),
    fireNumber: { amountMinor: projection.fireNumberMinor, currency: input.currency },
    growthAssumption: input.growthAssumption,
    scenarios: projection.scenarios.map((scenario) =>
      toAgentViewFireScenario(scenario, input.currency),
    ),
    status: "configured",
  };
}

/**
 * Measured annual returns for the plan's destination holdings (#547 measures,
 * IRR/CAGR from operations and cached prices). A destination with no cached
 * unit price or no measurable return is omitted so the projection falls back to
 * the assumed rate — a rate against an unknown current value would be
 * fabricated, never that.
 */
async function destinationAnnualReturns(
  store: AgentViewReadStore,
  input: {
    currency: string;
    operationsByAsset: Map<string, InvestmentOperation[]>;
    today: string;
    unitPrices: Record<string, string>;
  },
  assumedAnnualReturn: number,
): Promise<Record<string, number>> {
  const measurable = new Map(
    [...input.operationsByAsset].filter(
      ([assetId]) => input.unitPrices[assetId] !== undefined,
    ),
  );
  if (measurable.size === 0) {
    return {};
  }
  const assets = await store.readAssets();
  const instrumentByAsset = new Map<string, Instrument>(
    assets.map((asset) => [asset.id, instrumentOfAsset(asset)]),
  );
  const views = investmentReturnsById({
    cachedPriceByAsset: new Map(Object.entries(input.unitPrices)),
    currency: input.currency,
    instrumentByAsset,
    manualPriceByAsset: new Map(),
    operationsByAsset: measurable,
    valuationDate: input.today,
  });
  return Object.fromEntries(
    [...views].map(([assetId, view]) => [
      assetId,
      resolveHoldingAnnualReturnForProjection(view, assumedAnnualReturn),
    ]),
  );
}
