import type { AgentViewReadStore } from "@worthline/db";
import {
  addUnits,
  buildLiquidityBreakdown,
  calculateNetWorth,
  defaultsFor,
  listScopeOptions,
  multiplyToMinor,
  projectPortfolio,
} from "@worthline/domain";
import type {
  Instrument,
  InvestmentOperation,
  Liability,
  LiquidityTier,
  LiquidityTierBreakdown,
  ManualAsset,
  MoneyMinor,
  RowOwnership,
  ScopeOption,
  NetWorthSummary,
  Workspace,
} from "@worthline/domain";

import {
  AgentViewHttpError,
  type AgentViewAllocationSlice,
  type AgentViewConnectedSourceSummary,
  type AgentViewExposure,
  type AgentViewFinancialContext,
  type AgentViewFinancialSummary,
  type AgentViewHoldingDirection,
  type AgentViewHoldingsBlock,
  type AgentViewHoldingSummary,
  type AgentViewLiquidityRung,
  type AgentViewMoney,
  type AgentViewOperationSummary,
  type AgentViewOwnershipShare,
} from "./contract";
import { publicIdMap, requirePublicId, resolveInternalScopeId } from "./scope-resolution";
import { listAgentViewScopes } from "./scopes";

export const DEFAULT_HOLDING_LIMIT = 25;
export const MAX_HOLDING_LIMIT = 100;

export interface BuildFinancialContextOptions {
  /** Public scope ID (`wl_scp_…`) selected by the caller. */
  scopeId: string;
  /** Date the figures describe, as `YYYY-MM-DD`. */
  asOf: string;
  /** Cap on summarized holdings (default 25, clamped to 100). */
  holdingLimit?: number | undefined;
}

/**
 * Assemble the compact current financial context for a selected scope from
 * persisted state, with no side effects (PRD #328, #335). It reuses the same
 * domain figures the dashboard derives (`calculateNetWorth`) but never the
 * dashboard load path, so a read cannot refresh prices or capture snapshots.
 */
export function buildFinancialContext(
  store: AgentViewReadStore,
  options: BuildFinancialContextOptions,
): AgentViewFinancialContext {
  const workspace = store.readWorkspace();

  if (!workspace) {
    throw new AgentViewHttpError({
      code: "not_found",
      message: "Unknown scope.",
      status: 404,
    });
  }

  const scope = listAgentViewScopes(store).find(
    (candidate) => candidate.id === options.scopeId,
  );

  if (!scope) {
    throw new AgentViewHttpError({
      code: "not_found",
      message: "Unknown scope.",
      status: 404,
    });
  }

  const internalScopeId = resolveInternalScopeId(store, options.scopeId);
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

  const assets = store.readAssets();
  const liabilities = store.readLiabilities();
  const figuresInput = { assets, liabilities, scopeId: internalScopeId, workspace };
  const summary = toSummary(calculateNetWorth(figuresInput));
  const holdingSummaries = buildHoldingSummaries(
    store,
    workspace,
    scopeOption,
    assets,
    liabilities,
  );

  return {
    asOf: options.asOf,
    baseCurrency: workspace.baseCurrency,
    connectedSources: buildConnectedSources(store, holdingSummaries),
    exposure: buildExposure(holdingSummaries, summary.grossAssets),
    holdings: toHoldingsBlock(
      holdingSummaries,
      options.holdingLimit,
      workspace.baseCurrency,
    ),
    links: buildLinks(options.scopeId),
    liquidityBreakdown: buildLiquidityBreakdown(figuresInput).map(toLiquidityRung),
    scope,
    summary,
  };
}

/**
 * Scope-relative drilldown links the agent can follow for deeper facts. The
 * targets are owned by sibling slices (snapshots #336, FIRE #340, data quality
 * #341, trash #342); this slice publishes the canonical URLs.
 */
function buildLinks(publicScopeId: string): Record<string, string> {
  const base = `/api/v1/agent-view/scopes/${publicScopeId}`;
  return {
    dataQuality: `${base}/data-quality`,
    fireContext: `${base}/fire-context`,
    snapshots: `${base}/snapshots`,
    trashSummary: `${base}/trash-summary`,
  };
}

function toSummary(summary: NetWorthSummary): AgentViewFinancialSummary {
  return {
    debts: money(summary.debts),
    grossAssets: money(summary.grossAssets),
    housingEquity: money(summary.housingEquity),
    liquidNetWorth: money(summary.liquidNetWorth),
    netWorth: money(summary.totalNetWorth),
  };
}

function toLiquidityRung(rung: LiquidityTierBreakdown): AgentViewLiquidityRung {
  return {
    debts: money(rung.debts),
    grossAssets: money(rung.grossAssets),
    netValue: money(rung.netValue),
    shareOfGross: ratioStringFromBps(rung.shareOfGrossBps),
    tier: rung.tier,
  };
}

function buildHoldingSummaries(
  store: AgentViewReadStore,
  workspace: Workspace,
  scope: ScopeOption,
  assets: ManualAsset[],
  liabilities: Liability[],
): AgentViewHoldingSummary[] {
  const publicIds = store.readPublicIds();
  const holdingPublicIds = publicIdMap(publicIds, "holding");
  const memberPublicIds = publicIdMap(publicIds, "member");
  const memberLabels = new Map(
    workspace.members.map((member) => [member.id, member.name]),
  );
  const currency = workspace.baseCurrency;

  const projection = projectPortfolio({ assets, liabilities, scope, workspace });
  const common = { currency, holdingPublicIds, memberLabels, memberPublicIds };
  const investmentAssetIds = new Set(
    assets.filter((asset) => asset.type === "investment").map((asset) => asset.id),
  );

  const summaries: AgentViewHoldingSummary[] = [
    ...projection.sections[0].rows.map((row) =>
      toHoldingSummary({
        ...common,
        direction: "asset",
        operationSummary: investmentAssetIds.has(row.id)
          ? summarizeOperations(store.readOperations(row.id), currency)
          : undefined,
        row,
        valueMinor: row.valueMinor,
      }),
    ),
    ...projection.sections[1].rows.map((row) =>
      toHoldingSummary({
        ...common,
        direction: "liability",
        row,
        valueMinor: row.balanceMinor,
      }),
    ),
  ];

  return summaries.sort(compareHoldings);
}

/**
 * Fold an investment holding's operations into compact totals (PRD #328). Raw
 * ledger amounts — not scope-weighted — since operations are facts about the
 * holding, not a member's slice. Returns undefined when there are no operations.
 */
function summarizeOperations(
  operations: InvestmentOperation[],
  currency: string,
): AgentViewOperationSummary | undefined {
  if (operations.length === 0) {
    return undefined;
  }

  const ordered = [...operations].sort((a, b) =>
    a.executedAt === b.executedAt
      ? a.id.localeCompare(b.id)
      : a.executedAt.localeCompare(b.executedAt),
  );
  const first = ordered[0];
  const last = ordered[ordered.length - 1];

  if (!first || !last) {
    return undefined;
  }

  let unitsBought = "0";
  let unitsSold = "0";
  let grossBuyMinor = 0;
  let grossSellMinor = 0;
  let feesMinor = 0;

  for (const operation of operations) {
    feesMinor += operation.feesMinor;
    const amountMinor = multiplyToMinor(operation.units, operation.pricePerUnit);
    if (operation.kind === "buy") {
      unitsBought = addUnits(unitsBought, operation.units);
      grossBuyMinor += amountMinor;
    } else {
      unitsSold = addUnits(unitsSold, operation.units);
      grossSellMinor += amountMinor;
    }
  }

  return {
    feesTotal: moneyOf(feesMinor, currency),
    firstOperationDate: first.executedAt,
    grossBuyAmount: moneyOf(grossBuyMinor, currency),
    grossSellAmount: moneyOf(grossSellMinor, currency),
    latestOperationDate: last.executedAt,
    operationCount: operations.length,
    unitsBought,
    unitsSold,
  };
}

/**
 * Connected sources backing holdings in this scope, with the holdings they
 * materialized. Credentials never appear (the read port strips them) and the
 * full position lens lives in the #339 drilldown.
 */
function buildConnectedSources(
  store: AgentViewReadStore,
  holdingSummaries: AgentViewHoldingSummary[],
): AgentViewConnectedSourceSummary[] {
  const labelByPublicId = new Map(
    holdingSummaries.map((holding) => [holding.id, holding.label]),
  );
  const holdingPublicIds = publicIdMap(store.readPublicIds(), "holding");

  return store
    .readConnectedSources()
    .map((source) => ({
      adapter: source.adapter,
      label: source.label,
      lastSyncAt: source.lastSyncAt,
      projectedHoldings: source.assetIds
        .map((assetId) => holdingPublicIds.get(assetId))
        .filter(
          (publicId): publicId is string =>
            publicId !== undefined && labelByPublicId.has(publicId),
        )
        .map((publicId) => ({
          id: publicId,
          label: labelByPublicId.get(publicId) ?? "",
          object: "holding" as const,
        })),
    }))
    .filter((source) => source.projectedHoldings.length > 0);
}

function toHoldingsBlock(
  summaries: AgentViewHoldingSummary[],
  requestedLimit: number | undefined,
  currency: string,
): AgentViewHoldingsBlock {
  const limit = clampHoldingLimit(requestedLimit);
  const omitted = summaries.slice(limit);

  return {
    items: summaries.slice(0, limit),
    limit,
    omittedCount: omitted.length,
    omittedTotalValue: moneyOf(
      omitted.reduce((sum, holding) => sum + holding.currentValue.amountMinor, 0),
      currency,
    ),
  };
}

const EXPOSURE_TOP_HOLDINGS = 5;

/**
 * Concentration and allocation facts derived from the scope's holdings.
 * Weights are this holding/slice over total gross assets, as `0..1` decimal
 * strings (PRD #328). Allocation buckets cover assets only (gross exposure).
 */
function buildExposure(
  summaries: AgentViewHoldingSummary[],
  grossAssets: AgentViewMoney,
): AgentViewExposure {
  const grossMinor = grossAssets.amountMinor;
  const assetHoldings = summaries.filter((holding) => holding.direction === "asset");

  const topHoldings = assetHoldings.slice(0, EXPOSURE_TOP_HOLDINGS).map((holding) => ({
    id: holding.id,
    label: holding.label,
    object: "holding" as const,
    value: holding.currentValue,
    weight: weightOf(holding.currentValue.amountMinor, grossMinor),
  }));

  const topHoldingWeight = topHoldings[0]?.weight ?? "0";
  const topFiveWeightBps = topHoldings.reduce(
    (sum, holding) => sum + shareBps(holding.value.amountMinor, grossMinor),
    0,
  );

  return {
    byInstrument: allocationByKey(
      assetHoldings,
      (holding) => holding.instrument,
      grossMinor,
      grossAssets.currency,
    ),
    byLiquidityTier: allocationByKey(
      assetHoldings,
      (holding) => holding.liquidityTier,
      grossMinor,
      grossAssets.currency,
    ),
    concentration: {
      topFiveWeight: ratioStringFromBps(topFiveWeightBps),
      topHoldingWeight,
    },
    topHoldings,
  };
}

function allocationByKey(
  holdings: AgentViewHoldingSummary[],
  keyOf: (holding: AgentViewHoldingSummary) => string,
  grossMinor: number,
  currency: string,
): AgentViewAllocationSlice[] {
  const totals = new Map<string, number>();

  for (const holding of holdings) {
    totals.set(
      keyOf(holding),
      (totals.get(keyOf(holding)) ?? 0) + holding.currentValue.amountMinor,
    );
  }

  return [...totals.entries()]
    .map(([key, amountMinor]) => ({
      key,
      value: moneyOf(amountMinor, currency),
      weight: weightOf(amountMinor, grossMinor),
    }))
    .sort(
      (a, b) => b.value.amountMinor - a.value.amountMinor || a.key.localeCompare(b.key),
    );
}

function shareBps(amountMinor: number, grossMinor: number): number {
  if (grossMinor === 0) {
    return 0;
  }

  return Math.round((amountMinor * 10_000) / grossMinor);
}

function weightOf(amountMinor: number, grossMinor: number): string {
  return ratioStringFromBps(shareBps(amountMinor, grossMinor));
}

function toHoldingSummary(input: {
  row: {
    id: string;
    name: string;
    tier: LiquidityTier;
    instrument: Instrument;
    ownership: RowOwnership;
  };
  direction: AgentViewHoldingDirection;
  valueMinor: number;
  currency: string;
  holdingPublicIds: Map<string, string>;
  memberPublicIds: Map<string, string>;
  memberLabels: Map<string, string>;
  operationSummary?: AgentViewOperationSummary | undefined;
}): AgentViewHoldingSummary {
  return {
    currentValue: moneyOf(input.valueMinor, input.currency),
    direction: input.direction,
    id: requirePublicId(input.holdingPublicIds, input.row.id),
    instrument: input.row.instrument,
    label: input.row.name,
    liquidityTier: input.row.tier,
    object: "holding",
    ownership: toOwnership(
      input.row.ownership,
      input.memberPublicIds,
      input.memberLabels,
    ),
    valuationMethod: defaultsFor(input.row.instrument).valuationMethod,
    ...(input.operationSummary ? { operationSummary: input.operationSummary } : {}),
  };
}

function toOwnership(
  ownership: RowOwnership,
  memberPublicIds: Map<string, string>,
  memberLabels: Map<string, string>,
): AgentViewOwnershipShare[] {
  return ownership.shares
    .filter((share) => memberLabels.has(share.memberId))
    .map((share) => ({
      member: {
        id: requirePublicId(memberPublicIds, share.memberId),
        label: memberLabels.get(share.memberId) ?? "",
        object: "member" as const,
      },
      share: ratioStringFromBps(share.shareBps),
    }));
}

/** Sort by absolute current value desc, then label, then public ID (PRD #328). */
function compareHoldings(a: AgentViewHoldingSummary, b: AgentViewHoldingSummary): number {
  const byValue =
    Math.abs(b.currentValue.amountMinor) - Math.abs(a.currentValue.amountMinor);
  if (byValue !== 0) {
    return byValue;
  }

  const byLabel = a.label.localeCompare(b.label);
  return byLabel !== 0 ? byLabel : a.id.localeCompare(b.id);
}

function clampHoldingLimit(requested: number | undefined): number {
  if (requested === undefined) {
    return DEFAULT_HOLDING_LIMIT;
  }

  return Math.max(1, Math.min(requested, MAX_HOLDING_LIMIT));
}

function money(value: MoneyMinor): AgentViewMoney {
  return { amountMinor: value.amountMinor, currency: value.currency };
}

function moneyOf(amountMinor: number, currency: string): AgentViewMoney {
  return { amountMinor, currency };
}

/**
 * Format a basis-point share (0..10000) as an exact `0..1` decimal string —
 * the agent-view contract returns ratios as decimal strings (PRD #328). Pure
 * integer math, so no float artefacts at four decimals.
 */
export function ratioStringFromBps(bps: number): string {
  const sign = bps < 0 ? "-" : "";
  const abs = Math.abs(bps);
  const whole = Math.floor(abs / 10000);
  const frac = (abs % 10000).toString().padStart(4, "0").replace(/0+$/, "");
  return frac ? `${sign}${whole}.${frac}` : `${sign}${whole}`;
}
