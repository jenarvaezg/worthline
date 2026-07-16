import type { AgentViewReadStore, SnapshotHoldingRecord } from "@worthline/db";
import type {
  FireScopeConfig,
  Liability,
  LiquidityTierBreakdown,
  ManualAsset,
  MoneyMinor,
  NetWorthSnapshot,
  ScopeOption,
  Workspace,
} from "@worthline/domain";
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
import { deriveSourcePublicId } from "./connected-source-positions";
import {
  type AgentViewDataQualitySignal,
  type AgentViewFigureExcludedHolding,
  type AgentViewFigureExplanation,
  type AgentViewFigureFreshness,
  type AgentViewFigureIncludedHolding,
  type AgentViewFigureName,
  type AgentViewFigureSnapshotReference,
  type AgentViewFireAssumptions,
  AgentViewHttpError,
  type AgentViewLiquidityRung,
  type AgentViewLiquidityTier,
  type AgentViewMoney,
  type AgentViewObjectReference,
  type AgentViewScope,
} from "./contract";
import { buildDataQuality, MAX_DATA_QUALITY_LIMIT } from "./data-quality";
import { ratioStringFromBps } from "./financial-context";
import { goalReservationMinor } from "./fire-context";
import {
  publicIdMap,
  requirePublicId,
  resolveInternalHoldingId,
} from "./scope-resolution";
import { bindScope, type ScopedAgentView } from "./scoped-read";
import { listAgentViewScopes } from "./scopes";
import { deriveSnapshotPublicId } from "./snapshot-history";

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
  /** The figure to explain — already validated against the known enum. */
  figure: AgentViewFigureName;
  /** Public holding ID (`wl_hld_…`); required for `holding_value`. */
  holdingId?: string | undefined;
  /** Date the figures describe, as `YYYY-MM-DD` (the current date in current mode). */
  asOf: string;
  /**
   * A `YYYY-MM-DD` to switch to HISTORICAL mode (#344) against that day's exact
   * snapshot; absent keeps the CURRENT-mode behaviour (#343) unchanged.
   */
  date?: string | undefined;
}

/** The FIRE figures, which have no honest historical value (#344). */
const FIRE_FIGURE_NAMES: ReadonlySet<AgentViewFigureName> = new Set([
  "fire_eligible_assets",
  "fire_progress",
]);

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
export async function buildFigureExplanation(
  scoped: ScopedAgentView,
  options: BuildFigureExplanationOptions,
): Promise<AgentViewFigureExplanation> {
  const { store } = scoped;
  if (options.date !== undefined) {
    return buildHistoricalFigureExplanation(scoped, options, options.date);
  }

  const facts = await resolveScopeFacts(scoped, options.asOf);

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

// ── Historical figures (#344) ───────────────────────────────────────────────────

/**
 * The resolved scope plus the FROZEN snapshot a historical explanation reads
 * (#344). The snapshot is the scope's exact-date snapshot (there is exactly one
 * per scope per day); the frozen rows are its `snapshot_holdings` records — empty
 * for an old/legacy capture that stored only the headline figures.
 */
interface HistoricalSnapshotFacts {
  scope: AgentViewScope;
  internalScopeId: string;
  currency: string;
  snapshot: NetWorthSnapshot;
  /** The snapshot's frozen holding rows; empty for a legacy capture with none. */
  rows: SnapshotHoldingRecord[];
  /** The public snapshot reference (`wl_snp_…`) for the explanation. */
  snapshotRef: AgentViewFigureSnapshotReference;
  /** Live holding public ids (`wl_hld_…`), indexed by internal id. */
  holdingPublicIds: Map<string, string>;
  /** The date the explanation describes, as `YYYY-MM-DD`. */
  date: string;
}

/**
 * Explain one figure HISTORICALLY for a scope against an exact-date snapshot
 * (PRD #328, #344), with no side effects. FIRE figures have no honest historical
 * value, so a dated FIRE request fails fast (`422 unsupported_historical_fire`)
 * BEFORE any snapshot lookup. Otherwise the scope's exact snapshot is resolved
 * (a missing one is `404 snapshot_not_found`, never the nearest), and the figure
 * is decomposed from the snapshot's FROZEN rows: `full` when rows back it,
 * `partial` (the stored headline figure plus a `history_coverage` note) when the
 * snapshot is an old capture with no rows. Reads mutate nothing.
 */
async function buildHistoricalFigureExplanation(
  scoped: ScopedAgentView,
  options: BuildFigureExplanationOptions,
  date: string,
): Promise<AgentViewFigureExplanation> {
  const { store } = scoped;
  // FIRE has no honest historical value — reject before the snapshot lookup so a
  // dated FIRE request fails fast regardless of whether a snapshot exists.
  if (FIRE_FIGURE_NAMES.has(options.figure)) {
    throw new AgentViewHttpError({
      code: "unprocessable_entity",
      details: { figure: options.figure, reason: "unsupported_historical_fire" },
      message: "Historical FIRE is not supported.",
      status: 422,
    });
  }

  const facts = await resolveHistoricalSnapshotFacts(scoped, date);

  switch (options.figure) {
    case "net_worth":
      return historicalNetWorth(facts);
    case "gross_assets":
      return historicalGrossAssets(facts);
    case "debts":
      return historicalDebts(facts);
    case "liquid_net_worth":
      return historicalLiquidNetWorth(facts);
    case "housing_equity":
      return historicalHousingEquity(facts);
    case "liquidity_breakdown":
      return historicalLiquidityBreakdown(facts);
    case "holding_value":
      return historicalHoldingValue(store, facts, options.holdingId);
    default:
      // Only the FIRE figures fall through here, and they already threw 422
      // above; this default keeps the switch exhaustive without a dead arm.
      throw new AgentViewHttpError({
        code: "unprocessable_entity",
        details: { figure: options.figure, reason: "unsupported_historical_fire" },
        message: "Historical FIRE is not supported.",
        status: 422,
      });
  }
}

async function resolveHistoricalSnapshotFacts(
  scoped: ScopedAgentView,
  date: string,
): Promise<HistoricalSnapshotFacts> {
  const { store } = scoped;
  const workspace = await store.readWorkspace();

  if (!workspace) {
    throw unknownScope();
  }

  const scope = (await listAgentViewScopes(store)).find(
    (candidate) => candidate.id === scoped.scopeId,
  );

  if (!scope) {
    throw unknownScope();
  }

  const internalScopeId = await scoped.internalScopeId();

  // Exactly one snapshot per scope per day — never pick the nearest.
  const snapshot = (await store.readSnapshots(internalScopeId)).find(
    (candidate) => candidate.dateKey === date,
  );

  if (!snapshot) {
    throw new AgentViewHttpError({
      code: "not_found",
      details: { reason: "snapshot_not_found" },
      message: "No snapshot exists for the selected scope on that date.",
      status: 404,
    });
  }

  const rows = await store.readSnapshotHoldings({
    from: date,
    scopeId: internalScopeId,
    to: date,
  });

  return {
    currency: workspace.baseCurrency,
    date,
    holdingPublicIds: publicIdMap(await store.readPublicIds(), "holding"),
    internalScopeId,
    rows,
    scope,
    snapshot,
    snapshotRef: {
      date,
      id: deriveSnapshotPublicId(internalScopeId, date),
      object: "snapshot",
    },
  };
}

// ── Historical headline figures ─────────────────────────────────────────────────

function historicalNetWorth(facts: HistoricalSnapshotFacts): AgentViewFigureExplanation {
  const formula = {
    expression: "grossAssets − debts",
    operands: [
      { label: "grossAssets", value: money(facts.snapshot.grossAssets) },
      { label: "debts", value: money(facts.snapshot.debts) },
    ],
  };

  if (facts.rows.length === 0) {
    return partialHistorical(facts, "net_worth", money(facts.snapshot.totalNetWorth), {
      formula,
    });
  }

  const assetRows = facts.rows.filter((row) => row.kind === "asset");
  const liabilityRows = facts.rows.filter((row) => row.kind === "liability");

  return historicalBase(facts, {
    decompositionStatus: "full",
    excludedHoldings: liabilityRows.map((row) => ({
      ...frozenHoldingRef(facts, row),
      reason: "liability netted against gross assets",
    })),
    figure: "net_worth",
    formula,
    includedHoldings: assetRows.map((row) => frozenIncludedHolding(facts, row)),
    value: money(facts.snapshot.totalNetWorth),
  });
}

function historicalGrossAssets(
  facts: HistoricalSnapshotFacts,
): AgentViewFigureExplanation {
  const formula = {
    expression: "sum(assetHoldings)",
    operands: [{ label: "grossAssets", value: money(facts.snapshot.grossAssets) }],
  };

  if (facts.rows.length === 0) {
    return partialHistorical(facts, "gross_assets", money(facts.snapshot.grossAssets), {
      formula,
    });
  }

  return historicalBase(facts, {
    decompositionStatus: "full",
    excludedHoldings: [],
    figure: "gross_assets",
    formula,
    includedHoldings: facts.rows
      .filter((row) => row.kind === "asset")
      .map((row) => frozenIncludedHolding(facts, row)),
    value: money(facts.snapshot.grossAssets),
  });
}

function historicalDebts(facts: HistoricalSnapshotFacts): AgentViewFigureExplanation {
  const formula = {
    expression: "sum(liabilityHoldings)",
    operands: [{ label: "debts", value: money(facts.snapshot.debts) }],
  };

  if (facts.rows.length === 0) {
    return partialHistorical(facts, "debts", money(facts.snapshot.debts), { formula });
  }

  return historicalBase(facts, {
    decompositionStatus: "full",
    excludedHoldings: [],
    figure: "debts",
    formula,
    includedHoldings: facts.rows
      .filter((row) => row.kind === "liability")
      .map((row) => frozenIncludedHolding(facts, row)),
    value: money(facts.snapshot.debts),
  });
}

function historicalLiquidNetWorth(
  facts: HistoricalSnapshotFacts,
): AgentViewFigureExplanation {
  const formula = {
    expression: "liquidAssets − liquidDebts",
    operands: [{ label: "liquidNetWorth", value: money(facts.snapshot.liquidNetWorth) }],
  };

  if (facts.rows.length === 0) {
    return partialHistorical(
      facts,
      "liquid_net_worth",
      money(facts.snapshot.liquidNetWorth),
      { formula },
    );
  }

  const included: AgentViewFigureIncludedHolding[] = [];
  const excluded: AgentViewFigureExcludedHolding[] = [];

  for (const row of facts.rows) {
    if (row.kind === "asset") {
      if (row.liquidityTier !== null && isLiquid(row.liquidityTier)) {
        included.push(frozenIncludedHolding(facts, row));
      } else {
        excluded.push({
          ...frozenHoldingRef(facts, row),
          reason: `${row.liquidityTier ?? "illiquid"} rung is not liquid`,
        });
      }
    } else if (row.securesHousing) {
      excluded.push({
        ...frozenHoldingRef(facts, row),
        reason: "housing-securing debt nets against housing equity",
      });
    } else if (isLiquid(row.liquidityTier ?? "cash")) {
      excluded.push({
        ...frozenHoldingRef(facts, row),
        reason: "liquid debt netted against liquid assets",
      });
    } else {
      excluded.push({
        ...frozenHoldingRef(facts, row),
        reason: `debt on the ${row.liquidityTier ?? "cash"} rung is not liquid`,
      });
    }
  }

  return historicalBase(facts, {
    decompositionStatus: "full",
    excludedHoldings: excluded,
    figure: "liquid_net_worth",
    formula,
    includedHoldings: included,
    value: money(facts.snapshot.liquidNetWorth),
  });
}

function historicalHousingEquity(
  facts: HistoricalSnapshotFacts,
): AgentViewFigureExplanation {
  const formula = {
    expression: "housingAssets − housingDebts",
    operands: [{ label: "housingEquity", value: money(facts.snapshot.housingEquity) }],
  };

  if (facts.rows.length === 0) {
    return partialHistorical(
      facts,
      "housing_equity",
      money(facts.snapshot.housingEquity),
      { formula },
    );
  }

  const included: AgentViewFigureIncludedHolding[] = [];
  const excluded: AgentViewFigureExcludedHolding[] = [];

  for (const row of facts.rows) {
    if (row.kind === "asset") {
      if (row.countsAsHousing) {
        included.push(frozenIncludedHolding(facts, row));
      } else {
        excluded.push({
          ...frozenHoldingRef(facts, row),
          reason: "not a housing asset",
        });
      }
    } else if (row.securesHousing) {
      excluded.push({
        ...frozenHoldingRef(facts, row),
        reason: "housing-securing debt netted against housing assets",
      });
    } else {
      excluded.push({
        ...frozenHoldingRef(facts, row),
        reason: "debt does not secure a housing asset",
      });
    }
  }

  return historicalBase(facts, {
    decompositionStatus: "full",
    excludedHoldings: excluded,
    figure: "housing_equity",
    formula,
    includedHoldings: included,
    value: money(facts.snapshot.housingEquity),
  });
}

/**
 * The per-rung breakdown folded from the frozen rows (#344), mirroring the live
 * `buildLiquidityBreakdown` and the snapshot-history `toHoldingsSummary`: asset
 * rows bucket by their frozen rung, liability rows by their frozen rung (a
 * null-rung debt lands on `cash`). Without rows the snapshot has no per-rung
 * data, so it is `partial` with an empty breakdown and a `history_coverage` note.
 */
function historicalLiquidityBreakdown(
  facts: HistoricalSnapshotFacts,
): AgentViewFigureExplanation {
  const formula = {
    expression: "perRungNet(grossAssets − debts)",
    operands: [
      { label: "grossAssets", value: money(facts.snapshot.grossAssets) },
      { label: "debts", value: money(facts.snapshot.debts) },
    ],
  };

  if (facts.rows.length === 0) {
    return partialHistorical(facts, "liquidity_breakdown", [], { formula });
  }

  const grossByTier = new Map<AgentViewLiquidityTier, number>();
  const debtByTier = new Map<AgentViewLiquidityTier, number>();

  for (const row of facts.rows) {
    const tier = (row.liquidityTier ?? "cash") as AgentViewLiquidityTier;
    if (row.kind === "asset") {
      grossByTier.set(tier, (grossByTier.get(tier) ?? 0) + row.valueMinor);
    } else {
      debtByTier.set(tier, (debtByTier.get(tier) ?? 0) + row.valueMinor);
    }
  }

  const totalGross = facts.snapshot.grossAssets.amountMinor;
  const rungs: AgentViewLiquidityRung[] = HISTORICAL_LIQUIDITY_LADDER.map((tier) => {
    const grossMinor = grossByTier.get(tier) ?? 0;
    const debtMinor = debtByTier.get(tier) ?? 0;
    return {
      debts: moneyOf(debtMinor, facts.currency),
      grossAssets: moneyOf(grossMinor, facts.currency),
      netValue: moneyOf(grossMinor - debtMinor, facts.currency),
      shareOfGross: ratioStringFromBps(
        totalGross === 0 ? 0 : Math.round((grossMinor * 10_000) / totalGross),
      ),
      tier,
    };
  });

  const included: AgentViewFigureIncludedHolding[] = facts.rows.map((row) =>
    row.kind === "asset"
      ? frozenIncludedHolding(facts, row)
      : {
          ...frozenHoldingRef(facts, row),
          value: moneyOf(-row.valueMinor, facts.currency),
        },
  );

  return historicalBase(facts, {
    decompositionStatus: "full",
    excludedHoldings: [],
    figure: "liquidity_breakdown",
    formula,
    includedHoldings: included,
    value: rungs,
  });
}

/**
 * The frozen value of one holding on the snapshot date (#344). Resolves the
 * public id to its internal id (a 404 when the id names no holding at all, the
 * same as current mode), then finds the holding's frozen row in the snapshot.
 * No frozen row — either the snapshot has no rows at all, or the holding did not
 * exist that day — is a `422 unsupported_figure`: there is no honest historical
 * value to report, and we never fabricate one.
 */
async function historicalHoldingValue(
  store: AgentViewReadStore,
  facts: HistoricalSnapshotFacts,
  publicHoldingId: string | undefined,
): Promise<AgentViewFigureExplanation> {
  if (publicHoldingId === undefined) {
    throw new AgentViewHttpError({
      code: "bad_request",
      details: { reason: "missing_holding_id" },
      message: "holding_value requires a holdingId selector.",
      status: 400,
    });
  }

  const internalHoldingId = await resolveInternalHoldingId(store, publicHoldingId);
  const row = facts.rows.find((candidate) => candidate.holdingId === internalHoldingId);

  if (!row) {
    throw unsupportedFigure("holding_value");
  }

  return historicalBase(facts, {
    decompositionStatus: "full",
    excludedHoldings: [],
    figure: "holding_value",
    formula: {
      expression: "frozenHoldingValue",
      operands: [
        { label: "frozenValue", value: moneyOf(row.valueMinor, facts.currency) },
      ],
    },
    includedHoldings: [frozenIncludedHolding(facts, row)],
    value: moneyOf(row.valueMinor, facts.currency),
  });
}

// ── Historical helpers ──────────────────────────────────────────────────────────

/** Cash-first liquidity ladder, matching the live `liquidityBreakdown` order. */
const HISTORICAL_LIQUIDITY_LADDER: readonly AgentViewLiquidityTier[] = [
  "cash",
  "market",
  "term-locked",
  "illiquid",
  "housing",
];

/** Fields the figure-specific historical builders supply to `historicalBase`. */
interface HistoricalFigureParts {
  figure: AgentViewFigureName;
  value: AgentViewFigureExplanation["value"];
  formula: AgentViewFigureExplanation["formula"];
  includedHoldings: AgentViewFigureIncludedHolding[];
  excludedHoldings: AgentViewFigureExcludedHolding[];
  decompositionStatus: "full" | "partial";
  /** Extra quality notes beyond the row-derived defaults (e.g. history_coverage). */
  extraQualityNotes?: AgentViewDataQualitySignal[];
}

/** Assemble a historical explanation envelope shared by every figure. */
function historicalBase(
  facts: HistoricalSnapshotFacts,
  parts: HistoricalFigureParts,
): AgentViewFigureExplanation {
  return {
    asOf: facts.date,
    decompositionStatus: parts.decompositionStatus,
    excludedHoldings: parts.excludedHoldings,
    figure: parts.figure,
    formula: parts.formula,
    historical: true,
    includedHoldings: parts.includedHoldings,
    links: links(facts.scope.id),
    qualityNotes: parts.extraQualityNotes ?? [],
    scope: facts.scope,
    snapshot: facts.snapshotRef,
    value: parts.value,
  };
}

/**
 * A `partial` historical explanation for an old snapshot with no frozen rows
 * (#344): the honest stored headline value plus a `history_coverage` note
 * (`MISSING_SNAPSHOT_ROWS`) explaining the per-holding decomposition is absent.
 * Included/excluded holdings are empty (none were frozen) — never fabricated.
 */
function partialHistorical(
  facts: HistoricalSnapshotFacts,
  figure: AgentViewFigureName,
  value: AgentViewFigureExplanation["value"],
  parts: { formula: AgentViewFigureExplanation["formula"] },
): AgentViewFigureExplanation {
  return historicalBase(facts, {
    decompositionStatus: "partial",
    excludedHoldings: [],
    extraQualityNotes: [missingSnapshotRowsNote(facts)],
    figure,
    formula: parts.formula,
    includedHoldings: [],
    value,
  });
}

/** The `history_coverage` signal for a snapshot that froze no holding rows (#341 shape). */
function missingSnapshotRowsNote(
  facts: HistoricalSnapshotFacts,
): AgentViewDataQualitySignal {
  return {
    affected: { id: facts.scope.id, label: facts.scope.label, object: "scope" },
    category: "history_coverage",
    code: "MISSING_SNAPSHOT_ROWS",
    fixable: false,
    id: `dqs_hist_missing_rows_${facts.snapshot.id}`,
    label: `La captura del ${facts.snapshot.dateKey} no tiene desglose de holdings.`,
    object: "data_quality_signal",
    observedDate: facts.snapshot.dateKey,
    severity: "low",
  };
}

/** An included holding from a frozen row: the frozen value, plus a `wl_hld_` ref when known. */
function frozenIncludedHolding(
  facts: HistoricalSnapshotFacts,
  row: SnapshotHoldingRecord,
): AgentViewFigureIncludedHolding {
  return {
    ...frozenHoldingRef(facts, row),
    value: moneyOf(row.valueMinor, facts.currency),
  };
}

/**
 * The holding reference for a frozen row (#336's tolerant handling): the frozen
 * `label` always, and the `holding` ref only when the holding's public id still
 * exists (it may have been hard-deleted since the snapshot was frozen).
 */
function frozenHoldingRef(
  facts: HistoricalSnapshotFacts,
  row: SnapshotHoldingRecord,
): { holding: AgentViewObjectReference } {
  const publicId = facts.holdingPublicIds.get(row.holdingId);
  return {
    holding: {
      ...(publicId === undefined ? {} : { id: publicId }),
      label: row.label,
      object: "holding",
    } as AgentViewObjectReference,
  };
}

// ── Headline figures ──────────────────────────────────────────────────────────

async function explainNetWorth(
  store: AgentViewReadStore,
  facts: ResolvedScopeFacts,
  asOf: string,
): Promise<AgentViewFigureExplanation> {
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
    qualityNotes: await qualityNotesFor(store, facts, scopeWideHoldingIds(projection)),
    scope: facts.scope,
    value: money(summary.totalNetWorth),
  };
}

async function explainGrossAssets(
  store: AgentViewReadStore,
  facts: ResolvedScopeFacts,
  asOf: string,
): Promise<AgentViewFigureExplanation> {
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
    qualityNotes: await qualityNotesFor(store, facts, new Set(assetIds)),
    scope: facts.scope,
    value: money(summary.grossAssets),
  };
}

async function explainDebts(
  store: AgentViewReadStore,
  facts: ResolvedScopeFacts,
  asOf: string,
): Promise<AgentViewFigureExplanation> {
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
    qualityNotes: await qualityNotesFor(store, facts, new Set(liabilityIds)),
    scope: facts.scope,
    value: money(summary.debts),
  };
}

async function explainLiquidNetWorth(
  store: AgentViewReadStore,
  facts: ResolvedScopeFacts,
  asOf: string,
): Promise<AgentViewFigureExplanation> {
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
    qualityNotes: await qualityNotesFor(store, facts, relevant),
    scope: facts.scope,
    value: money(summary.liquidNetWorth),
  };
}

async function explainHousingEquity(
  store: AgentViewReadStore,
  facts: ResolvedScopeFacts,
  asOf: string,
): Promise<AgentViewFigureExplanation> {
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
    qualityNotes: await qualityNotesFor(store, facts, relevant),
    scope: facts.scope,
    value: money(summary.housingEquity),
  };
}

async function explainLiquidityBreakdown(
  store: AgentViewReadStore,
  facts: ResolvedScopeFacts,
  asOf: string,
): Promise<AgentViewFigureExplanation> {
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
    qualityNotes: await qualityNotesFor(store, facts, scopeWideHoldingIds(projection)),
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

async function explainHoldingValue(
  store: AgentViewReadStore,
  facts: ResolvedScopeFacts,
  asOf: string,
  publicHoldingId: string | undefined,
): Promise<AgentViewFigureExplanation> {
  if (publicHoldingId === undefined) {
    throw new AgentViewHttpError({
      code: "bad_request",
      details: { reason: "missing_holding_id" },
      message: "holding_value requires a holdingId selector.",
      status: 400,
    });
  }

  // A 404 when the public id names no holding at all.
  const internalHoldingId = await resolveInternalHoldingId(store, publicHoldingId);
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
  const freshness = assetRow
    ? await holdingFreshness(store, internalHoldingId)
    : undefined;

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
    qualityNotes: await qualityNotesFor(store, facts, new Set([internalHoldingId])),
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
async function holdingFreshness(
  store: AgentViewReadStore,
  internalHoldingId: string,
): Promise<AgentViewFigureFreshness> {
  const freshness = await store.readPriceFreshness(internalHoldingId);

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

async function explainFireEligibleAssets(
  store: AgentViewReadStore,
  facts: ResolvedScopeFacts,
  asOf: string,
): Promise<AgentViewFigureExplanation> {
  const { config, result } = await resolveFire(store, facts, "fire_eligible_assets");
  const eligibleIds = eligibleAssetIds(facts, config);

  return {
    asOf,
    assumptions: fireAssumptions(config, result, facts.currency),
    excludedHoldings: result.excludedAssets.map((excluded) => ({
      holding: holdingRef(facts.holdingPublicIds, excluded.id, excluded.name),
      reason: excluded.reason,
    })),
    figure: "fire_eligible_assets",
    formula:
      result.reservedForGoals && result.reservedForGoals.amountMinor > 0
        ? {
            expression: "sum(eligibleHoldings) − reservedForGoals",
            operands: [
              { label: "eligibleAssets", value: money(result.eligibleAssets) },
              { label: "reservedForGoals", value: money(result.reservedForGoals) },
            ],
          }
        : {
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
    qualityNotes: await qualityNotesFor(store, facts, eligibleIds),
    scope: facts.scope,
    value: money(result.eligibleAssets),
  };
}

async function explainFireProgress(
  store: AgentViewReadStore,
  facts: ResolvedScopeFacts,
  asOf: string,
): Promise<AgentViewFigureExplanation> {
  const { config, result } = await resolveFire(store, facts, "fire_progress");
  const eligibleIds = eligibleAssetIds(facts, config);

  return {
    asOf,
    assumptions: fireAssumptions(config, result, facts.currency),
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
    qualityNotes: await qualityNotesFor(store, facts, eligibleIds),
    scope: facts.scope,
    value: { ratio: fireProgressRatio(result.eligibleAssets, result.fireNumber) },
  };
}

/**
 * Resolve the scope's CURRENT FIRE config and result (PRD #328, #343). A scope
 * with no FIRE config has no figure to explain — there is no honest current FIRE
 * number — so it is a documented `422 unsupported_figure`, never a fabricated 0.
 */
async function resolveFire(
  store: AgentViewReadStore,
  facts: ResolvedScopeFacts,
  figure: AgentViewFigureName,
): Promise<{
  config: FireScopeConfig;
  result: ReturnType<typeof calculateFireForScope>;
}> {
  const config = (await store.readFireConfig())[facts.internalScopeId];

  if (config === undefined) {
    throw unsupportedFigure(figure);
  }

  // Subtract the same goal reservation get_fire_context applies (#426), so the
  // explained eligible total matches the tool's figure.
  const reservedForGoalsMinor = await goalReservationMinor(
    store,
    facts.workspace,
    facts.internalScopeId,
    config,
    facts.assets,
  );

  const result = calculateFireForScope(
    config,
    facts.assets,
    facts.liabilities,
    facts.workspace,
    facts.internalScopeId,
    reservedForGoalsMinor,
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
  result: ReturnType<typeof calculateFireForScope>,
  currency: string,
): AgentViewFireAssumptions {
  return {
    expectedRealReturn: (
      result.realReturnUsed ??
      config.expectedRealReturn ??
      0.05
    ).toString(),
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

async function resolveScopeFacts(
  scoped: ScopedAgentView,
  asOf: string,
): Promise<ResolvedScopeFacts> {
  const { store } = scoped;
  const workspace = await store.readWorkspace();

  if (!workspace) {
    throw unknownScope();
  }

  const scope = (await listAgentViewScopes(store)).find(
    (candidate) => candidate.id === scoped.scopeId,
  );

  if (!scope) {
    throw unknownScope();
  }

  const internalScopeId = await scoped.internalScopeId();
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

  // Curve-valued at asOf so a CURRENT explanation reports the same figures the
  // dashboard derives; the historical path reads frozen snapshots instead.
  const { assets, liabilities } = await store.readCurveValuedHoldings(asOf);

  return {
    assets,
    currency: workspace.baseCurrency,
    holdingPublicIds: publicIdMap(await store.readPublicIds(), "holding"),
    internalScopeId,
    liabilities,
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
async function qualityNotesFor(
  store: AgentViewReadStore,
  facts: ResolvedScopeFacts,
  relevantInternalIds: Set<string>,
): Promise<AgentViewDataQualitySignal[]> {
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
  for (const source of await store.readConnectedSources()) {
    if (source.assetIds.some((assetId) => relevantInternalIds.has(assetId))) {
      relevantSourceIds.add(deriveSourcePublicId(source.id));
    }
  }

  const { signals } = await buildDataQuality(bindScope(store, facts.scope.id), {
    limit: MAX_DATA_QUALITY_LIMIT,
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
