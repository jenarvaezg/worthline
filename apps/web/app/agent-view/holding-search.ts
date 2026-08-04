/**
 * Holding lookup by name / symbol (uso real 2026-07-30). The compact financial context is a
 * TOP-N: it sorts by absolute value desc and cuts at `holdingLimit`, reporting the
 * rest only as `omittedCount`. A holding at 0 € therefore sorts LAST and is the
 * first thing dropped — which is exactly the holding a user asks to delete («hay
 * un fondo a 0 €, elimínalo»), leaving the assistant with a ticker in hand and
 * nothing to do with it.
 *
 * This read closes that dead end: substring match over EVERY holding in the scope,
 * zero-valued ones included, returning the public id a baja/corrección needs plus
 * the procedencia mark so the answer is «this one is sync-owned» instead of a
 * refused write three turns later. Side-effect-free, accent-insensitive, bounded.
 */

import type { AgentViewReadStore, InvestmentAssetMeta } from "@worthline/db";
import {
  type InvestmentOperation,
  type Liability,
  listScopeOptions,
  type ManualAsset,
  projectPortfolio,
  type ScopeOption,
  type Workspace,
} from "@worthline/domain";

import { connectedSourceByAssetId } from "./connected-source-provenance";
import {
  type AgentViewHoldingDirection,
  type AgentViewHoldingMatch,
  type AgentViewHoldingProvenance,
  type AgentViewHoldingSearchPage,
  AgentViewHttpError,
} from "./contract";
import { resolveHoldingIdentity } from "./holding-identity";
import { publicIdMap, requirePublicId } from "./scope-resolution";
import type { ScopedAgentView } from "./scoped-read";
import { listAgentViewScopes } from "./scopes";

export const DEFAULT_HOLDING_MATCH_LIMIT = 10;
export const MAX_HOLDING_MATCH_LIMIT = 50;

export interface BuildHoldingSearchOptions {
  /** Date the values describe, as `YYYY-MM-DD` (curve-valued, like the context). */
  asOf: string;
  /** Free text: part of a name, or a symbol/ISIN. */
  query: string;
  /** Max matches returned, already clamped by the caller. */
  limit: number;
}

/** A holding row ready to be matched, with everything a match can key on. */
interface SearchableHolding {
  internalId: string;
  direction: AgentViewHoldingDirection;
  instrument: string;
  label: string;
  valueMinor: number;
  /** True when the holding keeps an operation ledger, so its units are derivable. */
  isInvestment: boolean;
  /**
   * What the instrument identity resolves FROM (#1346) — the projected asset row
   * and the investment reference row. Kept unresolved so `resolveHoldingIdentity`
   * stays the single place deciding a holding's ISIN and provider symbol.
   */
  asset: ManualAsset | undefined;
  meta: InvestmentAssetMeta | undefined;
}

/**
 * Fold a query or a candidate down to what a human means by "the same text":
 * lowercase, accent-stripped, whitespace-collapsed. «coleccion» then finds
 * «Colección», which is the difference between one turn and a dead end.
 */
export function normalizeSearchText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Find the scope's holdings whose name, price symbol, or ISIN contains the query.
 * Ranked by absolute value desc then label, so the obvious candidate leads — but
 * a 0 € holding is never dropped for being worth nothing, only for being beyond
 * the cap (`meta.truncated` says so).
 */
export async function buildHoldingSearch(
  scoped: ScopedAgentView,
  options: BuildHoldingSearchOptions,
): Promise<AgentViewHoldingSearchPage> {
  const query = normalizeSearchText(options.query);

  if (query.length === 0) {
    throw new AgentViewHttpError({
      code: "unprocessable_entity",
      details: { reason: "empty_query" },
      message: "A non-empty query is required to look up holdings.",
      status: 422,
    });
  }

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

  const { assets, liabilities } = await store.readCurveValuedHoldings(options.asOf);
  const searchable = await toSearchableHoldings(store, {
    assets,
    liabilities,
    scope: scopeOption,
    workspace,
  });

  const matched = searchable
    .map((holding) => ({ holding, matchedOn: matchField(holding, query) }))
    .filter(
      (entry): entry is { holding: SearchableHolding; matchedOn: MatchedField } =>
        entry.matchedOn !== null,
    )
    .sort(
      (a, b) =>
        Math.abs(b.holding.valueMinor) - Math.abs(a.holding.valueMinor) ||
        a.holding.label.localeCompare(b.holding.label) ||
        a.holding.internalId.localeCompare(b.holding.internalId),
    );

  const holdingPublicIds = publicIdMap(await store.readPublicIds(), "holding");
  const provenanceByAssetId = connectedSourceByAssetId(
    await store.readConnectedSources(),
  );

  return {
    // Units are folded from the ledger, so the operations are read ONLY for the
    // matches that survive the cap (≤ `limit`) and only for the investments among
    // them — the whole-scope scan above stays a projection, never N ledger reads.
    matches: await Promise.all(
      matched.slice(0, options.limit).map(async (entry) =>
        toHoldingMatch({
          connectedSource: provenanceByAssetId.get(entry.holding.internalId),
          currency: workspace.baseCurrency,
          holding: entry.holding,
          matchedOn: entry.matchedOn,
          operations: entry.holding.isInvestment
            ? await store.readOperations(entry.holding.internalId)
            : undefined,
          publicId: requirePublicId(holdingPublicIds, entry.holding.internalId),
        }),
      ),
    ),
    meta: {
      limit: options.limit,
      query,
      totalMatches: matched.length,
      truncated: matched.length > options.limit,
    },
  };
}

type MatchedField = AgentViewHoldingMatch["matchedOn"];

/** Which field the query hit, or null when this holding does not match at all. */
function matchField(holding: SearchableHolding, query: string): MatchedField | null {
  if (normalizeSearchText(holding.label).includes(query)) {
    return "label";
  }

  // The SAME identity the match will report, so a hit can never be on a field the
  // answer does not carry.
  const { isin, providerSymbol } = resolveHoldingIdentity({
    asset: holding.asset,
    meta: holding.meta,
  });

  if (providerSymbol && normalizeSearchText(providerSymbol).includes(query)) {
    return "providerSymbol";
  }
  if (isin && normalizeSearchText(isin).includes(query)) {
    return "isin";
  }
  return null;
}

/**
 * Project the scope's live holdings into matchable rows. Same projection the
 * compact context uses (`projectPortfolio`), so a match reports the same
 * scope-relative figure the context would — minus the per-holding operation
 * summary, which a lookup does not need and would pay for per row.
 */
async function toSearchableHoldings(
  store: AgentViewReadStore,
  input: {
    assets: ManualAsset[];
    liabilities: Liability[];
    scope: ScopeOption;
    workspace: Workspace;
  },
): Promise<SearchableHolding[]> {
  const projection = projectPortfolio(input);
  const assetById = new Map(input.assets.map((asset) => [asset.id, asset]));
  const metaById = new Map(
    (await store.readInvestmentAssetsWithMeta()).map((row) => [row.id, row]),
  );

  return [
    ...projection.sections[0].rows.map((row) => ({
      asset: assetById.get(row.id),
      direction: "asset" as const,
      instrument: row.instrument,
      internalId: row.id,
      isInvestment: assetById.get(row.id)?.type === "investment",
      label: row.name,
      meta: metaById.get(row.id),
      valueMinor: row.valueMinor,
    })),
    ...projection.sections[1].rows.map((row) => ({
      // A debt is not an instrument: it has no identity to resolve.
      asset: undefined,
      direction: "liability" as const,
      instrument: row.instrument,
      internalId: row.id,
      isInvestment: false,
      label: row.name,
      meta: undefined,
      valueMinor: row.balanceMinor,
    })),
  ];
}

function toHoldingMatch(input: {
  holding: SearchableHolding;
  matchedOn: MatchedField;
  publicId: string;
  currency: string;
  connectedSource: AgentViewHoldingProvenance | undefined;
  operations: readonly InvestmentOperation[] | undefined;
}): AgentViewHoldingMatch {
  const { holding } = input;

  return {
    ...resolveHoldingIdentity({
      asset: holding.asset,
      meta: holding.meta,
      operations: input.operations,
    }),
    currentValue: { amountMinor: holding.valueMinor, currency: input.currency },
    direction: holding.direction,
    id: input.publicId,
    instrument: holding.instrument,
    label: holding.label,
    matchedOn: input.matchedOn,
    object: "holding",
    ...(input.connectedSource ? { connectedSource: input.connectedSource } : {}),
  };
}

function unknownScope(): AgentViewHttpError {
  return new AgentViewHttpError({
    code: "not_found",
    message: "Unknown scope.",
    status: 404,
  });
}
