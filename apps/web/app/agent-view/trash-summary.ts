import type { AgentViewReadStore, AgentViewTrashedHolding } from "@worthline/db";
import { resolveScopeMemberIds } from "@worthline/domain";

import {
  AgentViewHttpError,
  type AgentViewHoldingDirection,
  type AgentViewMoney,
  type AgentViewTrashedHolding as AgentViewTrashedHoldingContract,
  type AgentViewTrashSummary,
} from "./contract";
import {
  compareDateId,
  decodeCursor,
  dropAfterCursor,
  encodeCursor,
  type DateIdKey,
} from "./cursor";
import { publicIdMap, requirePublicId, resolveInternalScopeId } from "./scope-resolution";
import { listAgentViewScopes } from "./scopes";

export const DEFAULT_TRASH_LIMIT = 100;
export const MAX_TRASH_LIMIT = 500;

export interface BuildTrashSummaryOptions {
  /** Public scope ID (`wl_scp_…`) selected by the caller. */
  scopeId: string;
  /** Page size, already clamped to `[1, MAX_TRASH_LIMIT]` by the caller. */
  limit: number;
  /** Opaque cursor from a previous page's `meta.nextCursor`. */
  cursor?: string | undefined;
}

/** A trashed holding paired with its derived sort key, before serialization. */
interface SortedTrashedHolding {
  holding: AgentViewTrashedHolding;
  publicId: string;
  /** The exact `deletedAt` ISO, or "" for a legacy row with no stamp (sorts last). */
  dateKey: string;
}

/**
 * Assemble a scope's trash summary — its recoverable, soft-deleted holdings — with
 * no side effects (PRD #328, #342). Trashed holdings live OUTSIDE the main
 * financial context (which excludes them by reading only live rows); this endpoint
 * surfaces them separately so an agent can reason about what is recoverable. A
 * read NEVER restores, hard-deletes, mutates trash/snapshots, creates public ids
 * lazily, writes audit rows, or exports transfer artifacts (ADR 0023): it resolves
 * each holding's existing `wl_hld_` id from the registry and reads stored facts.
 *
 * Sort: deleted date DESC, then public holding id DESC (`-date` reverses both),
 * for a strict total order — a legacy row with no `deletedAt` sorts last under DESC
 * (its date key is "").
 *
 * Scope relevance: a trashed holding is included when the selected scope owns a
 * share of it (its owner member ids intersect the scope's members), mirroring how
 * live holdings are scoped. The household scope resolves to every member, so it
 * sees all trash — the common case; member/group scopes see only their own.
 */
export async function buildTrashSummary(
  store: AgentViewReadStore,
  options: BuildTrashSummaryOptions,
): Promise<AgentViewTrashSummary> {
  const workspace = await store.readWorkspace();

  if (!workspace) {
    throw unknownScope();
  }

  const scope = (await listAgentViewScopes(store)).find(
    (candidate) => candidate.id === options.scopeId,
  );

  if (!scope) {
    throw unknownScope();
  }

  const internalScopeId = await resolveInternalScopeId(store, options.scopeId);
  const scopeMemberIds = new Set(resolveScopeMemberIds(workspace, internalScopeId));
  const holdingPublicIds = publicIdMap(await store.readPublicIds(), "holding");
  const currency = workspace.baseCurrency;

  const sorted: SortedTrashedHolding[] = (await store.readTrashedHoldings())
    .filter((holding) =>
      holding.ownerMemberIds.some((memberId) => scopeMemberIds.has(memberId)),
    )
    .map((holding) => ({
      dateKey: holding.deletedAt ?? "",
      holding,
      publicId: requirePublicId(holdingPublicIds, holding.id),
    }))
    .sort((a, b) => compareDateId(trashKey(a), trashKey(b), "-date"));

  const afterCursor = options.cursor
    ? dropAfterCursor(sorted, decodeCursor(options.cursor), "-date", trashKey)
    : sorted;

  const page = afterCursor.slice(0, options.limit);
  const hasNext = afterCursor.length > options.limit;
  const last = page[page.length - 1];
  const nextCursor =
    hasNext && last ? encodeCursor(last.dateKey, last.publicId) : undefined;

  return {
    holdings: page.map((entry) => toTrashedHolding(entry, currency)),
    meta: {
      hasNext,
      limit: options.limit,
      ...(nextCursor === undefined ? {} : { nextCursor }),
    },
  };
}

/** This trashed holding's stable sort key: its deleted instant then its public id. */
function trashKey(entry: SortedTrashedHolding): DateIdKey {
  return { dateKey: entry.dateKey, publicId: entry.publicId };
}

function toTrashedHolding(
  entry: SortedTrashedHolding,
  currency: string,
): AgentViewTrashedHoldingContract {
  const { holding } = entry;
  const direction: AgentViewHoldingDirection =
    holding.kind === "asset" ? "asset" : "liability";

  return {
    direction,
    id: entry.publicId,
    instrument: holding.instrument ?? "",
    label: holding.name,
    object: "holding",
    status: { hardDeletable: true, restorable: true },
    ...(holding.valueMinor === null
      ? {}
      : { value: money(holding.valueMinor, currency) }),
    ...(holding.deletedAt === null
      ? {}
      : { deletedDate: holding.deletedAt.slice(0, 10) }),
  };
}

function money(amountMinor: number, currency: string): AgentViewMoney {
  return { amountMinor, currency };
}

function unknownScope(): AgentViewHttpError {
  return new AgentViewHttpError({
    code: "not_found",
    message: "Unknown scope.",
    status: 404,
  });
}
