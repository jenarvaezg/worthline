/**
 * The one holding id the product says out loud (#1318).
 *
 * Until now the web addressed a holding by its internal storage id
 * (`asset_…`/`liability_…`) while the agent view and the MCP only accepted the
 * public registry id (`wl_hld_…`). Two vocabularies for one thing, and the
 * expensive half was the user's: the id in the URL bar — and therefore in the
 * assistant's `screenContext` — was exactly the one no tool would take, so the
 * model kept asking the user to fetch an id that can never work.
 *
 * The public id is now the ONLY id that appears in a URL: path, query or
 * fragment. The internal id stays what it always was — a storage key that never
 * leaves the server, still fine inside a hidden form field, never in a link.
 * There is deliberately no legacy redirect: an alias would just be the second
 * vocabulary wearing a hat, and every producer of a holding URL is converted.
 *
 * Pure on purpose: the rules are unit tests, and the route is left with one
 * decision — render, or `notFound()`.
 */

import type { ExportedPublicId } from "@worthline/domain";

/** The narrow store seam this module reads the registry through. */
export interface HoldingPublicIdReader {
  agentView: { readPublicIds: () => Promise<ExportedPublicId[]> };
}

/** The agent-view registry prefix for a holding (`packages/db/agent-view-public-ids.ts`). */
export const PUBLIC_HOLDING_ID_PREFIX = "wl_hld_";

export function isPublicHoldingId(id: string): boolean {
  return id.startsWith(PUBLIC_HOLDING_ID_PREFIX);
}

/** The holding's ficha — the single surface where a holding is edited/managed (#152). */
export function holdingDetailHref(publicHoldingId: string): string {
  return `/patrimonio/${publicHoldingId}/editar`;
}

/** The holding's row on the board, as an anchor target (the ficha's «← Volver»). */
export function holdingBoardHref(publicHoldingId: string): string {
  return `/patrimonio#${publicHoldingId}`;
}

export interface HoldingPublicIdIndex {
  /** Internal asset/liability id → public `wl_hld_…` id. */
  publicByInternal: ReadonlyMap<string, string>;
  /** Public `wl_hld_…` id → internal asset/liability id. */
  internalByPublic: ReadonlyMap<string, string>;
}

/**
 * Index the public-id registry rows for holdings in both directions. Scopes,
 * members and groups share the table but never the holding id space.
 */
export function holdingPublicIdIndex(
  rows: readonly ExportedPublicId[],
): HoldingPublicIdIndex {
  const publicByInternal = new Map<string, string>();
  const internalByPublic = new Map<string, string>();

  for (const row of rows) {
    if (row.entityType !== "holding") continue;
    publicByInternal.set(row.entityId, row.publicId);
    internalByPublic.set(row.publicId, row.entityId);
  }

  return { internalByPublic, publicByInternal };
}

/**
 * The internal id a `/patrimonio/[id]/…` route segment names, or null when the
 * segment is not a live public holding id — which is a plain 404. An internal
 * `asset_…` id is NOT a route: it is the vocabulary this issue retired, and
 * accepting it here would quietly keep both alive.
 */
export function resolveHoldingRoute(
  routeId: string,
  index: HoldingPublicIdIndex,
): string | null {
  if (!isPublicHoldingId(routeId)) return null;

  return index.internalByPublic.get(routeId) ?? null;
}

/**
 * The public id a holding is addressed by, or undefined when the registry has no
 * row for it.
 *
 * Every creation path registers one (`ensureAgentViewPublicIds` in the asset,
 * liability and connected-source stores, plus the workspace import and the #335
 * backfill migration), so a miss is a registry defect. The web layer still does
 * not throw on it: the callers here are read surfaces and post-commit redirects,
 * where a missing id would mean blanking a whole page or turning a mutation that
 * already succeeded into a 500. They drop the link or the scroll anchor instead.
 *
 * The defect is not swallowed — the agent view raises it as a controlled error
 * (`requirePublicId`, ADR 0023) because its contract cannot answer without the
 * id. There the read has nothing to degrade to; here it always does.
 *
 * What is never allowed is falling back to the internal `asset_…`/`liability_…`
 * id, which is the leak this module exists to close (#1318).
 */
export function holdingPublicIdOf(
  index: HoldingPublicIdIndex,
  internalHoldingId: string,
): string | undefined {
  return index.publicByInternal.get(internalHoldingId);
}

/**
 * Read and index the registry off a store. Callers already assembling a batched
 * read wave (`Promise.all`) should keep `readPublicIds()` in that wave and index
 * the rows with {@link holdingPublicIdIndex} instead, so the extra round trip
 * rides along rather than serializing behind it (#446).
 */
export async function readHoldingPublicIdIndex(
  store: HoldingPublicIdReader,
): Promise<HoldingPublicIdIndex> {
  return holdingPublicIdIndex(await store.agentView.readPublicIds());
}
