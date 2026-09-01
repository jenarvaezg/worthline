import type {
  DailyCaptureMissedPassReport,
  MaintainerAlertCategory,
  RaiseMaintainerAlertInput,
} from "@worthline/db";
import { parseDailyCapturePass } from "@worthline/db";

import { sourceSyncWorkspaceFromHoldingId } from "./source-sync-alert";

/**
 * The missed-capture maintainer-alert contract (#1339, ADR 0064 amended).
 *
 * Vercel Cron is best-effort on the current plan: it delivers late and sometimes
 * not at all, so whole daily-capture passes vanish without a trace. Latest-wins
 * (ADR 0005) softens the damage; this turns the silence into a signal on the
 * `/admin` alerts surface that already exists, with no new table and no new
 * dependency.
 *
 * Shape of the alert, and why:
 *   - `category: "missed_capture"` — the ONE category no model can raise (the
 *     chat tool's enum does not list it). The cron raises it about ITSELF.
 *   - `workspaceId` is the `fleet` sentinel: a missed pass belongs to no tenant.
 *   - `holdingId` is `daily-capture:<runKey>`, i.e. the SUBJECT of the alert
 *     rather than a holding. That makes the dedup key
 *     (`workspace + holding + category`) exactly "this one missed pass", so a
 *     retried run re-detecting the same gap accumulates an occurrence instead of
 *     minting a duplicate alert, while distinct missed passes stay distinct
 *     incidents a maintainer can close one by one.
 *
 * Owned by the `/admin` surface that renders it; the cron's dependency wiring
 * imports it to raise.
 */

/** Sentinel workspace id: a missed pass is fleet-wide, not a tenant's. */
export const MISSED_CAPTURE_ALERT_WORKSPACE_ID = "fleet";

const HOLDING_ID_PREFIX = "daily-capture:";

/** The dedup subject of one missed pass — see the module contract above. */
function missedCaptureHoldingId(runKey: string): string {
  return `${HOLDING_ID_PREFIX}${runKey}`;
}

/**
 * The run key behind a missed-capture alert's sentinel holding id, or null when
 * the id is a real holding's (every other category).
 */
export function missedCapturePassFromHoldingId(holdingId: string): string | null {
  return holdingId.startsWith(HOLDING_ID_PREFIX)
    ? holdingId.slice(HOLDING_ID_PREFIX.length)
    : null;
}

/**
 * How a maintainer surface names an alert's subject. Every category but
 * `missed_capture` is about a holding inside one workspace; a missed pass is about
 * the FLEET and encodes the pass in its key, so its sentinels are translated
 * rather than shown raw (#1339). Shared by the alert index and the detail header
 * so the two never disagree.
 */
export function maintainerAlertSubject(alert: {
  category: MaintainerAlertCategory;
  workspaceId: string;
  holdingId: string;
}): { isFleet: boolean; subject: string; workspace: string } {
  const pass =
    alert.category === "missed_capture"
      ? missedCapturePassFromHoldingId(alert.holdingId)
      : null;
  if (pass !== null) {
    return { isFleet: true, subject: dailyCapturePassLabel(pass), workspace: "flota" };
  }

  // A `sync_source` alert raised by the cron (#1755) also carries a sentinel
  // rather than a holding — its subject is the workspace's sync phase, since the
  // capture isolates that phase per workspace and not per holding. It is NOT
  // fleet-wide: the failure belongs to one tenant, and which one is half the
  // diagnosis, so the workspace stays named.
  if (
    alert.category === "sync_source" &&
    sourceSyncWorkspaceFromHoldingId(alert.holdingId) !== null
  ) {
    return {
      isFleet: false,
      subject: "sincronización de fuentes conectadas",
      workspace: alert.workspaceId,
    };
  }

  return { isFleet: false, subject: alert.holdingId, workspace: alert.workspaceId };
}

/** The forensic payload of one missed-pass occurrence (#1339). */
export interface MissedCapturePayload {
  category: "missed_capture";
  /** The maintainer-facing diagnosis, already spelled out in words. */
  summary: string;
  /** The pass that was never invoked (`YYYY-MM-DD:am|pm`). */
  missedRunKey: string;
  /** The last pass that WAS invoked before the gap was noticed. */
  latestInvokedRunKey: string;
  /** The pass that noticed the gap. */
  detectedByRunKey: string;
  detectedAt: string;
  /** Older missed passes the report's cap left out — 0 when the gap was fully listed. */
  omittedOlderPasses: number;
}

/**
 * A run key in maintainer-readable Spanish: `2026-07-28:pm` →
 * «28-07-2026, captura de tarde (≈21:00 UTC)». Says «captura», not «pasada», so it
 * never reads as the **value update pass** CONTEXT.md already defines. Degrades to
 * the raw key for anything the parser rejects — the surface must never lie or
 * crash over a stored string.
 */
export function dailyCapturePassLabel(runKey: string): string {
  const parsed = parseDailyCapturePass(runKey);
  if (!parsed) return runKey;
  const [year, month, day] = parsed.dateKey.split("-");
  const window =
    parsed.pass === "am"
      ? "captura de mañana (≈09:00 UTC)"
      : "captura de tarde (≈21:00 UTC)";
  return `${day}-${month}-${year}, ${window}`;
}

/**
 * One alert per missed pass, ready for `raiseMaintainerAlert`. The claim is
 * narrow on purpose: the baseline is which pass was INVOKED (every invocation
 * enqueues its job first), so a pass with no row genuinely never arrived — this
 * never blames the scheduler for a pass that ran and failed.
 */
export function buildMissedCaptureAlerts(
  report: DailyCaptureMissedPassReport,
): Array<RaiseMaintainerAlertInput & { payload: MissedCapturePayload }> {
  return report.missed.map((missedRunKey) => ({
    workspaceId: MISSED_CAPTURE_ALERT_WORKSPACE_ID,
    holdingId: missedCaptureHoldingId(missedRunKey),
    category: "missed_capture" as const,
    occurredAt: report.detectedAt,
    payload: {
      category: "missed_capture" as const,
      summary: missedCaptureSummary(report, missedRunKey),
      missedRunKey,
      latestInvokedRunKey: report.latestInvokedRunKey,
      detectedByRunKey: report.detectedByRunKey,
      detectedAt: report.detectedAt,
      omittedOlderPasses: report.omitted,
    },
  }));
}

function missedCaptureSummary(
  report: DailyCaptureMissedPassReport,
  missedRunKey: string,
): string {
  const tail =
    report.omitted > 0
      ? ` Hay ${report.omitted} captura(s) perdida(s) más antigua(s) fuera de este informe.`
      : "";
  return (
    `La ${dailyCapturePassLabel(missedRunKey)} nunca se invocó: el cron de Vercel es ` +
    `best-effort y se la saltó, así que no se encoló nada. Última captura invocada: ` +
    `${dailyCapturePassLabel(report.latestInvokedRunKey)}. Detectada por la ` +
    `${dailyCapturePassLabel(report.detectedByRunKey)}.${tail}`
  );
}

/**
 * Whether a stored occurrence payload is a missed-capture one. Structural, not
 * trusting: payloads are opaque JSON frozen at raise time, so the detail surface
 * checks EVERY field it dereferences before rendering them.
 */
export function isMissedCapturePayload(value: unknown): value is MissedCapturePayload {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as Partial<MissedCapturePayload>;
  return (
    candidate.category === "missed_capture" &&
    typeof candidate.summary === "string" &&
    typeof candidate.missedRunKey === "string" &&
    typeof candidate.latestInvokedRunKey === "string" &&
    typeof candidate.detectedByRunKey === "string" &&
    typeof candidate.omittedOlderPasses === "number"
  );
}
