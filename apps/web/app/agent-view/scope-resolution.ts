import type { AgentViewReadStore } from "@worthline/db";
import type { ExportedPublicId, ExportedPublicIdEntityType } from "@worthline/domain";

import { AgentViewHttpError } from "./contract";

/**
 * Resolve a public scope ID (`wl_scp_…`) to its internal scope id via the
 * public-ID registry. A missing entry means the caller named a scope that does
 * not exist, so it is a `404`, not an internal error.
 */
export async function resolveInternalScopeId(
  store: AgentViewReadStore,
  publicScopeId: string,
): Promise<string> {
  const entry = (await store.readPublicIds()).find(
    (row) => row.entityType === "scope" && row.publicId === publicScopeId,
  );

  if (!entry) {
    throw new AgentViewHttpError({
      code: "not_found",
      message: "Unknown scope.",
      status: 404,
    });
  }

  return entry.entityId;
}

/**
 * Resolve a public holding ID (`wl_hld_…`) to its internal asset/liability id via
 * the public-ID registry (a reverse lookup over the `holding` rows). A missing
 * entry means the caller named a holding that does not exist, so it is a `404`.
 */
export async function resolveInternalHoldingId(
  store: AgentViewReadStore,
  publicHoldingId: string,
): Promise<string> {
  const internalId = [
    ...publicIdMap(await store.readPublicIds(), "holding").entries(),
  ].find(([, publicId]) => publicId === publicHoldingId)?.[0];

  if (internalId === undefined) {
    throw new AgentViewHttpError({
      code: "not_found",
      message: "Unknown holding.",
      status: 404,
    });
  }

  return internalId;
}

/** Index the public-ID registry rows of one entity type by their internal id. */
export function publicIdMap(
  publicIds: ExportedPublicId[],
  entityType: ExportedPublicIdEntityType,
): Map<string, string> {
  return new Map(
    publicIds
      .filter((row) => row.entityType === entityType)
      .map((row) => [row.entityId, row.publicId]),
  );
}

/**
 * The public ID of a live entity that must have one. A missing entry is a
 * registry/backfill defect (agent reads never create IDs lazily, ADR 0023), so
 * it surfaces as a controlled `500` rather than a silent omission.
 */
export function requirePublicId(
  byEntityId: Map<string, string>,
  entityId: string,
): string {
  const publicId = byEntityId.get(entityId);

  if (!publicId) {
    throw new AgentViewHttpError({
      code: "internal_error",
      message: "Agent view public ID registry is incomplete.",
      status: 500,
    });
  }

  return publicId;
}
