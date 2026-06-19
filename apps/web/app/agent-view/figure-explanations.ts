import type { AgentViewReadStore } from "@worthline/db";
import {
  buildLiquidityBreakdown,
  calculateFireForScope,
  calculateNetWorth,
  defaultsFor,
  housingAssetIdsOf,
  isHousingAsset,
  isLiquid,
  listScopeOptions,
  projectPortfolio,
  rungForLiability,
  securesHousingAsset,
  tierOfAsset,
} from "@worthline/domain";
import type {
  FireScopeConfig,
  Liability,
  LiquidityTierBreakdown,
  ManualAsset,
  MoneyMinor,
  ScopeOption,
  Workspace,
} from "@worthline/domain";

import {
  AgentViewHttpError,
  type AgentViewDataQualitySignal,
  type AgentViewFigureExcludedHolding,
  type AgentViewFigureExplanation,
  type AgentViewFigureFreshness,
  type AgentViewFigureIncludedHolding,
  type AgentViewFigureName,
  type AgentViewFireAssumptions,
  type AgentViewLiquidityRung,
  type AgentViewMoney,
  type AgentViewObjectReference,
  type AgentViewScope,
} from "./contract";
import { buildDataQuality, MAX_DATA_QUALITY_LIMIT } from "./data-quality";
import { deriveSourcePublicId } from "./connected-source-positions";
import { ratioStringFromBps } from "./financial-context";
import {
  publicIdMap,
  requirePublicId,
  resolveInternalHoldingId,
  resolveInternalScopeId,
} from "./scope-resolution";
import { listAgentViewScopes } from "./scopes";

/** The current figures `explain_figure` honors (PRD #328, #343). */
export const FIGURE_NAMES: readonly AgentViewFigureName[] = [
  "net_worth",
  "liquid_net_worth",
  "gross_assets",
  "debts",
  "housing_equity",
  "liquidity_breakdown",
  "holding_value",
  "fire_eligible_assets",
  "fire_progress",
];

export function isFigureName(value: string): value is AgentViewFigureName {
  return (FIGURE_NAMES as readonly string[]).includes(value);
}

export interface BuildFigureExplanationOptions {
  /** Public scope ID (`wl_scp_…`) selected by the caller. */
  scopeId: string;
  /** The figure to explain — already validated against the known enum. */
  figure: AgentViewFigureName;
  /** Public holding ID (`wl_hld_…`); required for `holding_value`. */
  holdingId?: string | undefined;
  /** Date the figures describe, as `YYYY-MM-DD` (always current). */
  asOf: string;
}

/**
 * The resolved scope plus the live facts every figure explanation reads, with no
 * side effects (PRD #328, #343). A missing scope/workspace is a 404; the asset and
 * liability rows are scope-weighted via `projectPortfolio` (the same reconciled
 * figures the dashboard and compact context derive).
 */
interface ResolvedScopeFacts {
  scope: AgentViewScope;
  internalScopeId: string;
  scopeOption: ScopeOption;
  workspace: Workspace;
  assets: ManualAsset[];
  liabilities: Liability[];
  currency: string;
  holdingPublicIds: Map<string, string>;
}

/**
 * Assemble the explanation of one current figure for a selected scope from
 * persisted state, with no side effects (PRD #328, #343). It reuses the same
 * domain figures the dashboard and compact context derive (`calculateNetWorth`,
 * `buildLiquidityBreakdown`, `calculateFireForScope`) — never re-deriving a figure
 * — so an explanation can never disagree with the headline it explains. FIRE
 * figures use the CURRENT assumptions only; a historical (dated) explanation is
 * issue #344 and is rejected before this point.
 */
export function buildFigureExplanation(
  store: AgentViewReadStore,
  options: BuildFigureExplanationOptions,
): AgentViewFigureExplanation {
  const facts = resolveScopeFacts(store, options.scopeId);

  switch (options.figure) {
    case "net_worth":
      return explainNetWorth(store, facts, options.asOf);
    case "gross_assets":
      return explainGrossAssets(store, facts, options.asOf);
    case "debts":
      return explainDebts(store, facts, options.asOf);
    case "liquid_net_worth":
      return explainLiquidNetWorth(store, facts, options.asOf);
    case "housing_equity":
      return explainHousingEquity(store, facts, options.asOf);
    case "liquidity_breakdown":
      return explainLiquidityBreakdown(store, facts, options.asOf);
    case "holding_value":
      return explainHoldingValue(store, facts, options.asOf, options.holdingId);
    case "fire_eligible_assets":
      return explainFireEligibleAssets(store, facts, options.asOf);
    case "fire_progress":
      return explainFireProgress(store, facts, options.asOf);
  }
}

// ── Headline figures ──────────────────────────────────────────────────────────

function explainNetWorth(
  store: AgentViewReadStore,
  facts: ResolvedScopeFacts,
  asOf: string,
): AgentViewFigureExplanation {
  const summary = netWorth(facts);
  const projection = projectPortfolio(portfolioInput(facts));

  return {
    asOf,
    excludedHoldings: projection.sections[1].rows.map((row) => ({
      holding: holdingRef(facts.holdingPublicIds, row.id, row.name),
      reason: "liability netted against gross assets",
    })),
    figure: "net_worth",
    formula: {
      expression: "grossAssets − debts",
      operands: [
        { label: "grossAssets", value: money(summary.grossAssets) },
        { label: "debts", value: money(summary.debts) },
      ],
    },
    includedHoldings: projection.sections[0].rows.map((row) =>
      includedHolding(
        facts.holdingPublicIds,
        row.id,
        row.name,
        row.valueMinor,
        facts.currency,
      ),
    ),
    links: links(facts.scope.id),
    qualityNotes: qualityNotesFor(store, facts, scopeWideHoldingIds(projection)),
    scope: facts.scope,
    value: money(summary.totalNetWorth),
  };
}

function explainGrossAssets(
  store: AgentViewReadStore,
  facts: ResolvedScopeFacts,
  asOf: string,
): AgentViewFigureExplanation {
  const summary = netWorth(facts);
  const projection = projectPortfolio(portfolioInput(facts));
  const assetIds = projection.sections[0].rows.map((row) => row.id);

  return {
    asOf,
    excludedHoldings: [],
    figure: "gross_assets",
    formula: {
      expression: "sum(assetHoldings)",
      operands: [{ label: "grossAssets", value: money(summary.grossAssets) }],
    },
    includedHoldings: projection.sections[0].rows.map((row) =>
      includedHolding(
        facts.holdingPublicIds,
        row.id,
        row.name,
        row.valueMinor,
        facts.currency,
      ),
    ),
    links: links(facts.scope.id),
    qualityNotes: qualityNotesFor(store, facts, new Set(assetIds)),
    scope: facts.scope,
    value: money(summary.grossAssets),
  };
}

function explainDebts(
  store: AgentViewReadStore,
  facts: ResolvedScopeFacts,
  asOf: string,
): AgentViewFigureExplanation {
  const summary = netWorth(facts);
  const projection = projectPortfolio(portfolioInput(facts));
  const liabilityIds = projection.sections[1].rows.map((row) => row.id);

  return {
    asOf,
    excludedHoldings: [],
    figure: "debts",
    formula: {
      expression: "sum(liabilityHoldings)",
      operands: [{ label: "debts", value: money(summary.debts) }],
    },
    includedHoldings: projection.sections[1].rows.map((row) =>
      includedHolding(
        facts.holdingPublicIds,
        row.id,
        row.name,
        row.balanceMinor,
        facts.currency,
      ),
    ),
    links: links(facts.scope.id),
    qualityNotes: qualityNotesFor(store, facts, new Set(liabilityIds)),
    scope: facts.scope,
    value: money(summary.debts),
  };
}

function explainLiquidNetWorth(
  store: AgentViewReadStore,
  facts: ResolvedScopeFacts,
  asOf: string,
): AgentViewFigureExplanation {
  const summary = netWorth(facts);
  const projection = projectPortfolio(portfolioInput(facts));
  const housingAssetIds = housingAssetIdsOf(facts.assets);
  const assetTierById = new Map(
    facts.assets.map((asset) => [asset.id, tierOfAsset(asset)]),
  );

  const included: AgentViewFigureIncludedHolding[] = [];
  const excluded: AgentViewFigureExcludedHolding[] = [];
  const relevant = new Set<string>();

  for (const row of projection.sections[0].rows) {
    if (isLiquid(row.tier)) {
      included.push(
        includedHolding(
          facts.holdingPublicIds,
          row.id,
          row.name,
          row.valueMinor,
          facts.currency,
        ),
      );
      relevant.add(row.id);
    } else {
      excluded.push({
        holding: holdingRef(facts.holdingPublicIds, row.id, row.name),
        reason: `${row.tier} rung is not liquid`,
      });
    }
  }

  for (const liability of facts.liabilities) {
    const balance = scopedLiabilityMinor(projection, liability.id);
    if (balance === undefined) {
      continue;
    }

    const securesHousing = securesHousingAsset(liability, housingAssetIds);
    const rung = rungForLiability(liability, assetTierById);

    if (!securesHousing && isLiquid(rung)) {
      // A liquid, non-housing debt nets against liquid assets; it is part of the
      // figure but shown on the debts side, not as a liquid asset holding.
      excluded.push({
        holding: holdingRef(facts.holdingPublicIds, liability.id, liability.name),
        reason: "liquid debt netted against liquid assets",
      });
      relevant.add(liability.id);
    } else {
      excluded.push({
        holding: holdingRef(facts.holdingPublicIds, liability.id, liability.name),
        reason: securesHousing
          ? "housing-securing debt nets against housing equity"
          : `debt on the ${rung} rung is not liquid`,
      });
    }
  }

  return {
    asOf,
    excludedHoldings: excluded,
    figure: "liquid_net_worth",
    formula: {
      expression: "liquidAssets − liquidDebts",
      operands: [{ label: "liquidNetWorth", value: money(summary.liquidNetWorth) }],
    },
    includedHoldings: included,
    links: links(facts.scope.id),
    qualityNotes: qualityNotesFor(store, facts, relevant),
    scope: facts.scope,
    value: money(summary.liquidNetWorth),
  };
}

function explainHousingEquity(
  store: AgentViewReadStore,
  facts: ResolvedScopeFacts,
  asOf: string,
): AgentViewFigureExplanation {
  const summary = netWorth(facts);
  const projection = projectPortfolio(portfolioInput(facts));
  const housingAssetIds = housingAssetIdsOf(facts.assets);
  const isHousingById = new Map(
    facts.assets.map((asset) => [asset.id, isHousingAsset(asset)]),
  );

  const included: AgentViewFigureIncludedHolding[] = [];
  const excluded: AgentViewFigureExcludedHolding[] = [];
  const relevant = new Set<string>();

  for (const row of projection.sections[0].rows) {
    if (isHousingById.get(row.id)) {
      included.push(
        includedHolding(
          facts.holdingPublicIds,
          row.id,
          row.name,
          row.valueMinor,
          facts.currency,
        ),
      );
      relevant.add(row.id);
    } else {
      excluded.push({
        holding: holdingRef(facts.holdingPublicIds, row.id, row.name),
        reason: "not a housing asset",
      });
    }
  }

  for (const liability of facts.liabilities) {
    const balance = scopedLiabilityMinor(projection, liability.id);
    if (balance === undefined) {
      continue;
    }
    if (securesHousingAsset(liability, housingAssetIds)) {
      excluded.push({
        holding: holdingRef(facts.holdingPublicIds, liability.id, liability.name),
        reason: "housing-securing debt netted against housing assets",
      });
      relevant.add(liability.id);
    } else {
      excluded.push({
        holding: holdingRef(facts.holdingPublicIds, liability.id, liability.name),
        reason: "debt does not secure a housing asset",
      });
    }
  }

  return {
    asOf,
    excludedHoldings: excluded,
    figure: "housing_equity",
    formula: {
      expression: "housingAssets − housingDebts",
      operands: [{ label: "housingEquity", value: money(summary.housingEquity) }],
    },
    includedHoldings: included,
    links: links(facts.scope.id),
    qualityNotes: qualityNotesFor(store, facts, relevant),
    scope: facts.scope,
    value: money(summary.housingEquity),
  };
}

function explainLiquidityBreakdown(
  store: AgentViewReadStore,
  facts: ResolvedScopeFacts,
  asOf: string,
): AgentViewFigureExplanation {
  const breakdown = buildLiquidityBreakdown(figuresInput(facts));
  const projection = projectPortfolio(portfolioInput(facts));

  return {
    asOf,
    excludedHoldings: [],
    figure: "liquidity_breakdown",
    formula: {
      expression: "perRungNet(grossAssets − debts)",
      operands: breakdown.map((rung) => ({
        label: `${rung.tier} net`,
        value: money(rung.netValue),
      })),
    },
    includedHoldings: liquidityIncludedHoldings(facts, breakdown),
    links: links(facts.scope.id),
    qualityNotes: qualityNotesFor(store, facts, scopeWideHoldingIds(projection)),
    scope: facts.scope,
    value: breakdown.map(toLiquidityRung),
  };
}

/** Every holding the per-rung breakdown placed, as an included holding with its rung. */
function liquidityIncludedHoldings(
  facts: ResolvedScopeFacts,
  breakdown: LiquidityTierBreakdown[],
): AgentViewFigureIncludedHolding[] {
  const included: AgentViewFigureIncludedHolding[] = [];

  for (const rung of breakdown) {
    for (const asset of rung.assets) {
      included.push(
        includedHolding(
          facts.holdingPublicIds,
          asset.id,
          asset.name,
          asset.valueMinor,
          facts.currency,
        ),
      );
    }
    for (const liability of rung.liabilities) {
      included.push({
        holding: holdingRef(facts.holdingPublicIds, liability.id, liability.name),
        value: moneyOf(-liability.valueMinor, facts.currency),
      });
    }
  }

  return included;
}

// ── holding_value ──────────────────────────────────────────────────────────────

function explainHoldingValue(
  store: AgentViewReadStore,
  facts: ResolvedScopeFacts,
  asOf: string,
  publicHoldingId: string | undefined,
): AgentViewFigureExplanation {
  if (publicHoldingId === undefined) {
    throw new AgentViewHttpError({
      code: "bad_request",
      details: { reason: "missing_holding_id" },
      message: "holding_value requires a holdingId selector.",
      status: 400,
    });
  }

  // A 404 when the public id names no holding at all.
  const internalHoldingId = resolveInternalHoldingId(store, publicHoldingId);
  const projection = projectPortfolio(portfolioInput(facts));

  const assetRow = projection.sections[0].rows.find(
    (row) => row.id === internalHoldingId,
  );
  const liabilityRow = projection.sections[1].rows.find(
    (row) => row.id === internalHoldingId,
  );

  if (!assetRow && !liabilityRow) {
    // The holding exists but the selected scope does not own it.
    throw unsupportedFigure("holding_value");
  }

  const valueMinor = assetRow ? assetRow.valueMinor : liabilityRow!.balanceMinor;
  const name = assetRow ? assetRow.name : liabilityRow!.name;
  const instrument = assetRow ? assetRow.instrument : liabilityRow!.instrument;
  const valuationMethod = defaultsFor(instrument).valuationMethod;
  // Liabilities are priced from plan/anchor facts, not a provider price-cache entry;
  // freshness only applies to provider-priced asset holdings.
  const freshness = assetRow ? holdingFreshness(store, internalHoldingId) : undefined;

  return {
    asOf,
    excludedHoldings: [],
    figure: "holding_value",
    formula: {
      expression: `holdingValue(method: ${valuationMethod})`,
      operands: [{ label: "currentValue", value: moneyOf(valueMinor, facts.currency) }],
    },
    ...(freshness !== undefined ? { freshness } : {}),
    includedHoldings: [
      includedHolding(
        facts.holdingPublicIds,
        internalHoldingId,
        name,
        valueMinor,
        facts.currency,
      ),
    ],
    links: links(facts.scope.id),
    qualityNotes: qualityNotesFor(store, facts, new Set([internalHoldingId])),
    scope: facts.scope,
    value: moneyOf(valueMinor, facts.currency),
  };
}

/**
 * The price/source freshness of a holding's value (PRD #328, #343). A
 * provider-priced asset carries its cached quote's freshness; a manual/derived
 * holding with no cached price reports `manual`, so a client always learns how
 * the single value it asked about was sourced.
 */
function holdingFreshness(
  store: AgentViewReadStore,
  internalHoldingId: string,
): AgentViewFigureFreshness {
  const freshness = store.readPriceFreshness(internalHoldingId);

  if (freshness === null) {
    return { status: "manual" };
  }

  return {
    asOf: freshness.fetchedAt.slice(0, 10),
    source: freshness.source,
    status: freshness.freshnessState,
  };
}

// ── FIRE figures (current assumptions only) ─────────────────────────────────────

function explainFireEligibleAssets(
  store: AgentViewReadStore,
  facts: ResolvedScopeFacts,
  asOf: string,
): AgentViewFigureExplanation {
  const { config, result } = resolveFire(store, facts, "fire_eligible_assets");
  const eligibleIds = eligibleAssetIds(facts, config);

  return {
    asOf,
    assumptions: fireAssumptions(config, facts.currency),
    excludedHoldings: result.excludedAssets.map((excluded) => ({
      holding: holdingRef(facts.holdingPublicIds, excluded.id, excluded.name),
      reason: excluded.reason,
    })),
    figure: "fire_eligible_assets",
    formula: {
      expression: "sum(fireEligibleAssets)",
      operands: [{ label: "eligibleAssets", value: money(result.eligibleAssets) }],
    },
    includedHoldings: projectPortfolio(portfolioInput(facts))
      .sections[0].rows.filter((row) => eligibleIds.has(row.id))
      .map((row) =>
        includedHolding(
          facts.holdingPublicIds,
          row.id,
          row.name,
          row.valueMinor,
          facts.currency,
        ),
      ),
    links: links(facts.scope.id),
    qualityNotes: qualityNotesFor(store, facts, eligibleIds),
    scope: facts.scope,
    value: money(result.eligibleAssets),
  };
}

function explainFireProgress(
  store: AgentViewReadStore,
  facts: ResolvedScopeFacts,
  asOf: string,
): AgentViewFigureExplanation {
  const { config, result } = resolveFire(store, facts, "fire_progress");
  const eligibleIds = eligibleAssetIds(facts, config);

  return {
    asOf,
    assumptions: fireAssumptions(config, facts.currency),
    excludedHoldings: result.excludedAssets.map((excluded) => ({
      holding: holdingRef(facts.holdingPublicIds, excluded.id, excluded.name),
      reason: excluded.reason,
    })),
    figure: "fire_progress",
    formula: {
      expression: "eligibleAssets ÷ fireNumber",
      operands: [
        { label: "eligibleAssets", value: money(result.eligibleAssets) },
        { label: "fireNumber", value: money(result.fireNumber) },
      ],
    },
    includedHoldings: projectPortfolio(portfolioInput(facts))
      .sections[0].rows.filter((row) => eligibleIds.has(row.id))
      .map((row) =>
        includedHolding(
          facts.holdingPublicIds,
          row.id,
          row.name,
          row.valueMinor,
          facts.currency,
        ),
      ),
    links: links(facts.scope.id),
    qualityNotes: qualityNotesFor(store, facts, eligibleIds),
    scope: facts.scope,
    value: { ratio: fireProgressRatio(result.eligibleAssets, result.fireNumber) },
  };
}

/**
 * Resolve the scope's CURRENT FIRE config and result (PRD #328, #343). A scope
 * with no FIRE config has no figure to explain — there is no honest current FIRE
 * number — so it is a documented `422 unsupported_figure`, never a fabricated 0.
 */
function resolveFire(
  store: AgentViewReadStore,
  facts: ResolvedScopeFacts,
  figure: AgentViewFigureName,
): { config: FireScopeConfig; result: ReturnType<typeof calculateFireForScope> } {
  const config = store.readFireConfig()[facts.internalScopeId];

  if (config === undefined) {
    throw unsupportedFigure(figure);
  }

  const result = calculateFireForScope(
    config,
    facts.assets,
    facts.workspace,
    facts.internalScopeId,
  );

  return { config, result };
}

/**
 * The internal asset ids that count toward the FIRE-eligible total for the scope:
 * every asset that is neither the primary residence nor manually excluded in the
 * config — the same filter `calculateFireForScope` applies.
 */
function eligibleAssetIds(
  facts: ResolvedScopeFacts,
  config: FireScopeConfig,
): Set<string> {
  const manuallyExcluded = new Set(config.excludedAssetIds ?? []);
  return new Set(
    facts.assets
      .filter((asset) => !asset.isPrimaryResidence && !manuallyExcluded.has(asset.id))
      .map((asset) => asset.id),
  );
}

function fireAssumptions(
  config: FireScopeConfig,
  currency: string,
): AgentViewFireAssumptions {
  return {
    expectedRealReturn: config.expectedRealReturn.toString(),
    monthlySpending: moneyOf(config.monthlySpendingMinor, currency),
    safeWithdrawalRate: config.safeWithdrawalRate.toString(),
  };
}

/** `eligibleAssets / fireNumber` as a non-negative decimal string (`0` if unreachable). */
function fireProgressRatio(eligibleAssets: MoneyMinor, fireNumber: MoneyMinor): string {
  if (fireNumber.amountMinor <= 0) {
    return "0";
  }

  const bps = Math.round((eligibleAssets.amountMinor * 10_000) / fireNumber.amountMinor);
  return ratioStringFromBps(bps);
}

// ── Shared helpers ──────────────────────────────────────────────────────────────

function resolveScopeFacts(
  store: AgentViewReadStore,
  publicScopeId: string,
): ResolvedScopeFacts {
  const workspace = store.readWorkspace();

  if (!workspace) {
    throw unknownScope();
  }

  const scope = listAgentViewScopes(store).find(
    (candidate) => candidate.id === publicScopeId,
  );

  if (!scope) {
    throw unknownScope();
  }

  const internalScopeId = resolveInternalScopeId(store, publicScopeId);
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

  return {
    assets: store.readAssets(),
    currency: workspace.baseCurrency,
    holdingPublicIds: publicIdMap(store.readPublicIds(), "holding"),
    internalScopeId,
    liabilities: store.readLiabilities(),
    scope,
    scopeOption,
    workspace,
  };
}

function netWorth(facts: ResolvedScopeFacts) {
  return calculateNetWorth(figuresInput(facts));
}

/** The `{ workspace, scopeId, assets, liabilities }` shape the figure engines read. */
function figuresInput(facts: ResolvedScopeFacts) {
  return {
    assets: facts.assets,
    liabilities: facts.liabilities,
    scopeId: facts.internalScopeId,
    workspace: facts.workspace,
  };
}

function portfolioInput(facts: ResolvedScopeFacts) {
  return {
    assets: facts.assets,
    liabilities: facts.liabilities,
    scope: facts.scopeOption,
    workspace: facts.workspace,
  };
}

/** Every holding (asset + liability) the scope owns — the scope-wide relevance set. */
function scopeWideHoldingIds(
  projection: ReturnType<typeof projectPortfolio>,
): Set<string> {
  return new Set([
    ...projection.sections[0].rows.map((row) => row.id),
    ...projection.sections[1].rows.map((row) => row.id),
  ]);
}

/** The scope-weighted balance of a liability row, or undefined when the scope owns none. */
function scopedLiabilityMinor(
  projection: ReturnType<typeof projectPortfolio>,
  liabilityId: string,
): number | undefined {
  return projection.sections[1].rows.find((row) => row.id === liabilityId)?.balanceMinor;
}

/**
 * The data-quality signals relevant to a figure (PRD #328, #343): the scope's
 * full #341 signal set, narrowed to signals affecting the figure's holdings plus
 * the scope-global signals. Reuses `buildDataQuality` so the notes never drift
 * from the data-quality endpoint. Read-only — surfacing a note writes nothing.
 */
function qualityNotesFor(
  store: AgentViewReadStore,
  facts: ResolvedScopeFacts,
  relevantInternalIds: Set<string>,
): AgentViewDataQualitySignal[] {
  const relevantPublicIds = new Set(
    [...relevantInternalIds]
      .map((internalId) => facts.holdingPublicIds.get(internalId))
      .filter((publicId): publicId is string => publicId !== undefined),
  );

  // Build the set of connected-source public IDs (`wl_src_…`) whose backing asset
  // holdings overlap the figure's relevant holdings. A source_freshness or
  // projection_gap signal is scoped to the source, not the holding, so we must
  // widen the filter to include it when any of that source's holdings are in scope.
  const relevantSourceIds = new Set<string>();
  for (const source of store.readConnectedSources()) {
    if (source.assetIds.some((assetId) => relevantInternalIds.has(assetId))) {
      relevantSourceIds.add(deriveSourcePublicId(source.id));
    }
  }

  const { signals } = buildDataQuality(store, {
    limit: MAX_DATA_QUALITY_LIMIT,
    scopeId: facts.scope.id,
  });

  return signals.filter((signal) => {
    if (signal.affected === undefined) {
      // A scope-global signal (e.g. sparse history, missing FIRE config) is
      // always relevant to a scope-level figure.
      return true;
    }
    if (signal.affected.object === "scope") {
      return signal.affected.id === facts.scope.id;
    }
    if (signal.affected.object === "connected_source") {
      return relevantSourceIds.has(signal.affected.id);
    }
    return relevantPublicIds.has(signal.affected.id);
  });
}

function includedHolding(
  holdingPublicIds: Map<string, string>,
  internalId: string,
  label: string,
  amountMinor: number,
  currency: string,
): AgentViewFigureIncludedHolding {
  return {
    holding: holdingRef(holdingPublicIds, internalId, label),
    value: moneyOf(amountMinor, currency),
  };
}

function holdingRef(
  holdingPublicIds: Map<string, string>,
  internalId: string,
  label: string,
): AgentViewObjectReference {
  return {
    id: requirePublicId(holdingPublicIds, internalId),
    label,
    object: "holding",
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

function links(publicScopeId: string): Record<string, string> {
  const base = `/api/v1/agent-view/scopes/${publicScopeId}`;
  return {
    dataQuality: `${base}/data-quality`,
    financialContext: `${base}/financial-context`,
    fireContext: `${base}/fire-context`,
  };
}

function money(value: MoneyMinor): AgentViewMoney {
  return { amountMinor: value.amountMinor, currency: value.currency };
}

function moneyOf(amountMinor: number, currency: string): AgentViewMoney {
  return { amountMinor, currency };
}

function unsupportedFigure(figure: AgentViewFigureName): AgentViewHttpError {
  return new AgentViewHttpError({
    code: "unprocessable_entity",
    details: { figure, reason: "unsupported_figure" },
    message: "This figure is not supported for the selected scope.",
    status: 422,
  });
}

function unknownScope(): AgentViewHttpError {
  return new AgentViewHttpError({
    code: "not_found",
    message: "Unknown scope.",
    status: 404,
  });
}
