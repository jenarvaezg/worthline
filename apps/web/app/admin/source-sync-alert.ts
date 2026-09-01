import type {
  DailyCaptureSourceSyncFailure,
  RaiseMaintainerAlertInput,
} from "@worthline/db";

/**
 * The source-sync maintainer-alert contract (#1755, ADR 0064 amended).
 *
 * The nightly capture syncs every workspace's connected sources before freezing
 * the snapshot. That phase degrades on purpose — an outage keeps last-known
 * values rather than zeroing a holding — and its errors were collected into
 * `sourceSyncFailures` "for observability". There was no observer: nothing in
 * `apps/web` read the field.
 *
 * What that cost: a Numista revalue failed every night from 2026-08-10 to
 * 2026-09-01 in BOTH workspaces holding a collection, and left no trace anywhere.
 * The revalue does not open a `sync_run`, so the connections page kept showing
 * the last good run; the only mark was a `stale` price-cache row carrying a
 * generic sentence the page does not even render. Three weeks, and the way it was
 * finally found was a hand-written probe against production.
 *
 * `sync_source` is the category ADR 0064 already defines for exactly this smell —
 * "a source stuck for weeks, a sync that returned nothing" — with a label, an
 * `/admin` renderer and an evidence rule (`sourceIsDiagnosable`) all in place.
 * Nothing ever raised it. This is the emitter.
 *
 * Shape of the alert, and why:
 *   - `workspaceId` is the REAL workspace: unlike a missed pass (fleet-wide), a
 *     degraded sync belongs to one tenant, and which tenant is half the diagnosis.
 *   - `holdingId` is the `source-sync:<workspaceId>` sentinel rather than a
 *     holding. The failure arrives per workspace, not per holding — the phase
 *     isolates per workspace — so this keeps the dedup key
 *     (`workspace + holding + category`) at "this workspace's sync phase". A run
 *     that fails again accumulates an occurrence instead of minting a duplicate,
 *     which is what turns 21 identical nights into one incident with a count.
 */

const HOLDING_ID_PREFIX = "source-sync:";

/** The dedup subject of one workspace's sync phase — see the module contract. */
function sourceSyncHoldingId(workspaceId: string): string {
  return `${HOLDING_ID_PREFIX}${workspaceId}`;
}

/**
 * The workspace behind a source-sync alert's sentinel holding id, or null when the
 * id is a real holding's (every other category).
 */
export function sourceSyncWorkspaceFromHoldingId(holdingId: string): string | null {
  return holdingId.startsWith(HOLDING_ID_PREFIX)
    ? holdingId.slice(HOLDING_ID_PREFIX.length)
    : null;
}

/** The forensic payload of one degraded sync phase. */
export interface SourceSyncAlertPayload {
  category: "sync_source";
  summary: string;
  /** Every error message the phase collected for this workspace, verbatim. */
  errors: string[];
  detectedAt: string;
}

/**
 * One alert per workspace whose sync phase degraded, ready for
 * `raiseMaintainerAlert`. Several errors in one workspace ride ONE alert: they
 * come from the same phase of the same night, and splitting them would fragment
 * the incident the dedup key exists to keep together.
 *
 * Pure: the caller does the raising, so the contract is unit-testable without a
 * control plane.
 */
export function buildSourceSyncAlerts(
  failures: readonly DailyCaptureSourceSyncFailure[],
  detectedAt: string,
): Array<RaiseMaintainerAlertInput & { payload: SourceSyncAlertPayload }> {
  const byWorkspace = new Map<string, string[]>();
  for (const failure of failures) {
    const errors = byWorkspace.get(failure.workspaceId) ?? [];
    errors.push(failure.error);
    byWorkspace.set(failure.workspaceId, errors);
  }

  return [...byWorkspace].map(([workspaceId, errors]) => ({
    workspaceId,
    holdingId: sourceSyncHoldingId(workspaceId),
    category: "sync_source" as const,
    occurredAt: detectedAt,
    payload: {
      category: "sync_source" as const,
      summary: sourceSyncSummary(errors),
      errors,
      detectedAt,
    },
  }));
}

/**
 * The one-line claim a maintainer reads first. Names the count and quotes the
 * FIRST error, which is the one that usually explains the rest — the whole list
 * rides the payload for the detail view.
 */
function sourceSyncSummary(errors: string[]): string {
  const head = errors[0] ?? "sin mensaje";
  const tail =
    errors.length > 1 ? ` (y ${errors.length - 1} error(es) más en la misma pasada)` : "";
  return (
    `La sincronización de fuentes conectadas falló en la captura nocturna: ` +
    `${head}${tail}. Las cifras se quedan en la última sincronización buena.`
  );
}
