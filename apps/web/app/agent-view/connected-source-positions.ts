import type {
  AgentViewConnectedSource,
  AgentViewReadStore,
  AgentViewSourceFreshness,
} from "@worthline/db";
import { coinValue, positionValue } from "@worthline/domain";
import type { CoinPosition, SourcePosition, TokenPosition } from "@worthline/domain";

import {
  AgentViewHttpError,
  type AgentViewConnectedSourcePosition,
  type AgentViewConnectedSourcePositionGroup,
  type AgentViewConnectedSourcePositionGroupPage,
  type AgentViewConnectedSourcePositionPage,
  type AgentViewLiquidityTier,
  type AgentViewObjectReference,
  type AgentViewPositionValuationBasis,
  type AgentViewSourceFreshnessSummary,
} from "./contract";
import { compareDateId, decodeCursor, dropAfterCursor, encodeCursor } from "./cursor";
import { derivePublicId } from "./derived-id";
import {
  publicIdMap,
  requirePublicId,
  resolveInternalHoldingId,
} from "./scope-resolution";

export const DEFAULT_POSITION_LIMIT = 100;
export const MAX_POSITION_LIMIT = 500;

export interface BuildHoldingConnectedSourcePositionsOptions {
  /** Public holding ID (`wl_hld_…`) selected by the caller. */
  holdingId: string;
  /** Page size, already clamped to `[1, MAX_POSITION_LIMIT]` by the caller. */
  limit: number;
  /** Opaque cursor from a previous page's `meta.nextCursor`. */
  cursor?: string | undefined;
}

export interface BuildSourceConnectedSourcePositionsOptions {
  /** Public source ID (`wl_src_…`) selected by the caller. */
  sourceId: string;
  /** Page size, already clamped to `[1, MAX_POSITION_LIMIT]` by the caller. */
  limit: number;
  /** Opaque cursor from a previous page's `meta.nextCursor`. */
  cursor?: string | undefined;
}

/** A position with its derived public id and the holding/rung it projects into. */
interface ProjectedPosition {
  position: SourcePosition;
  publicId: string;
  projectedHolding: AgentViewObjectReference;
  liquidityTier: AgentViewLiquidityTier;
  /** Stable composite group key (holding public id + rung), for cursor ordering. */
  groupKey: string;
}

/**
 * Assemble the connected-source positions projected into ONE holding/rung with no
 * side effects (PRD #328, #339): the positions the source mirrors onto the
 * holding's rung, with valuation basis, freshness, and quality signals. A
 * holding NOT backed by a connected source is a documented semantic error
 * (`422`); an unknown holding is a `404`. Reads persisted positions only — never
 * syncs or revalues (ADR 0023).
 */
export function buildHoldingConnectedSourcePositions(
  store: AgentViewReadStore,
  options: BuildHoldingConnectedSourcePositionsOptions,
): AgentViewConnectedSourcePositionPage {
  if (!store.readWorkspace()) {
    throw unknownHolding();
  }

  const internalHoldingId = resolveInternalHoldingId(store, options.holdingId);
  const source = store
    .readConnectedSources()
    .find((candidate) => candidate.assetIds.includes(internalHoldingId));

  if (!source) {
    throw new AgentViewHttpError({
      code: "unprocessable_entity",
      message: "Connected-source positions are only available for connected holdings.",
      status: 422,
    });
  }

  const holdingPublicIds = publicIdMap(store.readPublicIds(), "holding");
  const freshness = toFreshnessSummary(source, store.readSourceFreshness(source.id));
  const projected = projectPositions(store, source, holdingPublicIds).filter(
    (entry) => entry.position.liquidityTier === tierOfAsset(store, internalHoldingId),
  );

  // Within one holding/rung the positions already share the group; order by the
  // stable position public id so cursor pagination never repeats or skips a row.
  const sorted = projected.sort((a, b) =>
    compareDateId(positionKey(a), positionKey(b), "date"),
  );
  const { page, hasNext, nextCursor } = paginate(sorted, options.limit, options.cursor);

  return {
    meta: {
      hasNext,
      limit: options.limit,
      ...(nextCursor === undefined ? {} : { nextCursor }),
    },
    positions: page.map((entry) => toPosition(entry, source, freshness)),
  };
}

/**
 * Assemble ALL of a connected source's positions, grouped by their projected
 * holding/rung, with no side effects (PRD #328, #339). An unknown source is a
 * `404`. Pagination walks a stable (holding, rung, position) order over the flat
 * position list, then re-folds the page into its groups (a group can span page
 * boundaries). Reads persisted positions only — never syncs or revalues.
 */
export function buildSourceConnectedSourcePositions(
  store: AgentViewReadStore,
  options: BuildSourceConnectedSourcePositionsOptions,
): AgentViewConnectedSourcePositionGroupPage {
  if (!store.readWorkspace()) {
    throw unknownSource();
  }

  const source = resolveSource(store, options.sourceId);
  const holdingPublicIds = publicIdMap(store.readPublicIds(), "holding");
  const freshness = toFreshnessSummary(source, store.readSourceFreshness(source.id));

  // Stable order: group key (holding public id + rung) first, then position
  // public id — a strict total order, so cursor pagination over it is stable.
  const sorted = projectPositions(store, source, holdingPublicIds).sort((a, b) =>
    compareDateId(positionKey(a), positionKey(b), "date"),
  );
  const { page, hasNext, nextCursor } = paginate(sorted, options.limit, options.cursor);

  return {
    groups: foldGroups(
      page.map((entry) => ({
        entry,
        position: toPosition(entry, source, freshness),
      })),
    ),
    meta: {
      hasNext,
      limit: options.limit,
      ...(nextCursor === undefined ? {} : { nextCursor }),
    },
  };
}

/** Project a source's positions onto their holding/rung, deriving stable ids. */
function projectPositions(
  store: AgentViewReadStore,
  source: AgentViewConnectedSource,
  holdingPublicIds: Map<string, string>,
): ProjectedPosition[] {
  return store.readSourcePositions(source.id).map((position) => {
    const internalHoldingId = assetIdForTier(store, source, position.liquidityTier);

    if (internalHoldingId === undefined) {
      // A mirrored position whose rung has no projected holding is a sync /
      // projection defect — fail closed (ADR 0023) rather than emit an empty ref.
      throw new AgentViewHttpError({
        code: "internal_error",
        message: "Connected-source position has no projected holding.",
        status: 500,
      });
    }

    // Connected rung-assets are registered on connect/sync, so a missing public
    // id is a registry/backfill defect — surface the same controlled 500 the rest
    // of the agent view uses (requirePublicId), never a dishonest empty id.
    const holdingPublicId = requirePublicId(holdingPublicIds, internalHoldingId);
    const projectedHolding: AgentViewObjectReference = {
      id: holdingPublicId,
      label: source.label,
      object: "holding",
    };
    const publicId = derivePositionPublicId(source.id, position.externalId);
    return {
      groupKey: `${holdingPublicId}|${position.liquidityTier}`,
      liquidityTier: position.liquidityTier as AgentViewLiquidityTier,
      position,
      projectedHolding,
      publicId,
    };
  });
}

/** Drop everything up to the cursor, slice the page, and derive the next cursor. */
function paginate(
  sorted: ProjectedPosition[],
  limit: number,
  cursor: string | undefined,
): { page: ProjectedPosition[]; hasNext: boolean; nextCursor: string | undefined } {
  const afterCursor = cursor
    ? dropAfterCursor(sorted, decodeCursor(cursor), "date", positionKey)
    : sorted;
  const page = afterCursor.slice(0, limit);
  const hasNext = afterCursor.length > limit;
  const last = page[page.length - 1];
  const nextCursor =
    hasNext && last ? encodeCursor(last.groupKey, last.publicId) : undefined;
  return { hasNext, nextCursor, page };
}

/** Fold a page's positions back into their projected-holding/rung groups, in order. */
function foldGroups(
  rows: { entry: ProjectedPosition; position: AgentViewConnectedSourcePosition }[],
): AgentViewConnectedSourcePositionGroup[] {
  const groups: AgentViewConnectedSourcePositionGroup[] = [];
  const byKey = new Map<string, AgentViewConnectedSourcePositionGroup>();

  for (const { entry, position } of rows) {
    let group = byKey.get(entry.groupKey);
    if (!group) {
      group = {
        groupValue: { amountMinor: 0, currency: position.value.currency },
        liquidityTier: entry.liquidityTier,
        positions: [],
        projectedHolding: entry.projectedHolding,
      };
      byKey.set(entry.groupKey, group);
      groups.push(group);
    }
    group.positions.push(position);
    group.groupValue = {
      amountMinor: group.groupValue.amountMinor + position.value.amountMinor,
      currency: group.groupValue.currency,
    };
  }

  return groups;
}

/** Map one projected position to its agent-view contract shape (secret-free). */
function toPosition(
  entry: ProjectedPosition,
  source: AgentViewConnectedSource,
  freshness: AgentViewSourceFreshnessSummary | undefined,
): AgentViewConnectedSourcePosition {
  const { position } = entry;
  const valued = position.kind === "coin" ? valueCoin(position) : valueToken(position);

  return {
    adapter: source.adapter,
    groupKey: groupKeyOf(position),
    id: entry.publicId,
    kind: position.kind,
    label: position.name,
    liquidityTier: entry.liquidityTier,
    object: "connected_source_position",
    projectedHolding: entry.projectedHolding,
    qualitySignals: valued.qualitySignals,
    quantity: valued.quantity,
    sourceLabel: source.label,
    value: { amountMinor: valued.minor, currency: position.currency },
    valuationBasis: valued.basis,
    ...(freshness === undefined ? {} : { freshness }),
    ...(valued.unitPrice === undefined ? {} : { unitPrice: valued.unitPrice }),
  };
}

interface ValuedPosition {
  minor: number;
  basis: AgentViewPositionValuationBasis;
  quantity: string;
  unitPrice?: string;
  qualitySignals: string[];
}

/** Value a coin: `max(metal, numismatic)` → purchase fallback → 0 (ADR 0017). */
function valueCoin(position: CoinPosition): ValuedPosition {
  const { minor, basis } = coinValue(position);
  if (basis === "zero") {
    return {
      basis: "unvalued",
      minor: 0,
      qualitySignals: ["No value could be derived; reported at 0."],
      quantity: String(position.quantity),
    };
  }
  return {
    basis,
    minor,
    qualitySignals: [],
    quantity: String(position.quantity),
  };
}

/** Value a token live as `balance × unitPrice`; unpriced → 0 with a signal (ADR 0021). */
function valueToken(position: TokenPosition): ValuedPosition {
  const { minor, basis } = positionValue(position.balance, position.unitPrice);
  if (basis === "zero" || position.unitPrice === null) {
    return {
      basis: "unvalued",
      minor: 0,
      qualitySignals: ["No unit price available; reported at 0."],
      quantity: position.balance,
    };
  }
  return {
    basis: "market",
    minor,
    qualitySignals: [],
    quantity: position.balance,
    unitPrice: position.unitPrice,
  };
}

/** The grouping-lens key: a coin's metal, a token's symbol (ADR 0017/0021). */
function groupKeyOf(position: SourcePosition): string | null {
  return position.kind === "coin" ? position.metal : position.symbol;
}

/** Resolve a `wl_src_` public id to the source it names, or `404` if unknown. */
function resolveSource(
  store: AgentViewReadStore,
  publicSourceId: string,
): AgentViewConnectedSource {
  const source = store
    .readConnectedSources()
    .find((candidate) => deriveSourcePublicId(candidate.id) === publicSourceId);

  if (!source) {
    throw unknownSource();
  }

  return source;
}

/** This source's asset id on a given rung (its projected holding for that rung). */
function assetIdForTier(
  store: AgentViewReadStore,
  source: AgentViewConnectedSource,
  tier: string,
): string | undefined {
  return source.assetIds.find((assetId) => tierOfAsset(store, assetId) === tier);
}

/** The liquidity rung of an asset, read from the live asset rows. */
function tierOfAsset(store: AgentViewReadStore, assetId: string): string | undefined {
  return store.readAssets().find((asset) => asset.id === assetId)?.liquidityTier;
}

/** Fold the read-port freshness into the contract summary, with the last sync. */
export function toFreshnessSummary(
  source: AgentViewConnectedSource,
  freshness: AgentViewSourceFreshness | null,
): AgentViewSourceFreshnessSummary | undefined {
  if (freshness === null && source.lastSyncAt === null) {
    return undefined;
  }

  const status = freshness?.freshnessState ?? "unknown";
  const isFailedSignal =
    freshness !== null &&
    (freshness.freshnessState === "failed" || freshness.freshnessState === "stale");

  return {
    status,
    ...(source.lastSyncAt === null ? {} : { lastSuccessfulSyncAt: source.lastSyncAt }),
    ...(isFailedSignal && freshness
      ? {
          lastFailedSync: {
            at: freshness.fetchedAt,
            ...(freshness.staleReason === undefined
              ? {}
              : { reason: freshness.staleReason }),
          },
        }
      : {}),
  };
}

/**
 * Derive a source's opaque public ID from its stable internal id (PRD #328).
 * Deterministic, so it survives export/import; opaque, so it leaks no internal id
 * (ADR 0023). No registry write — a read derives it without mutating state.
 */
export function deriveSourcePublicId(internalSourceId: string): string {
  return derivePublicId("src", internalSourceId);
}

/**
 * Derive a position's opaque public ID from the source id + the source's STABLE
 * per-line id (`externalId`), NOT worthline's internal position id (reassigned
 * each sync). So the id survives a wholesale re-sync (PRD #328). Deterministic
 * and opaque (ADR 0023); no registry write.
 */
export function derivePositionPublicId(sourceId: string, externalId: string): string {
  return derivePublicId("pos", `${sourceId}:${externalId}`);
}

/** This position's stable sort key: its group key, then its derived public ID. */
function positionKey(entry: ProjectedPosition): { dateKey: string; publicId: string } {
  return { dateKey: entry.groupKey, publicId: entry.publicId };
}

function unknownHolding(): AgentViewHttpError {
  return new AgentViewHttpError({
    code: "not_found",
    message: "Unknown holding.",
    status: 404,
  });
}

function unknownSource(): AgentViewHttpError {
  return new AgentViewHttpError({
    code: "not_found",
    message: "Unknown connected source.",
    status: 404,
  });
}
