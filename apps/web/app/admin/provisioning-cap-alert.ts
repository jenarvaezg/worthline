import { DAILY_PROVISIONING_CAP_ENV } from "@web/provisioning-cap";
import type { RaiseMaintainerAlertInput } from "@worthline/db";

/**
 * The provisioning-cap maintainer-alert contract (#1175, ADR 0064 amended).
 *
 * When the day's provisioning cap turns a new identity away, the refused person
 * gets the honest «hoy estamos llenos» — and the maintainer has to hear about
 * it, or demand bouncing off the fuse is invisible. The `/admin` alerts surface
 * already exists for exactly this kind of signal; this is its emitter.
 *
 * Shape of the alert, and why:
 *   - `category: "provisioning_cap"` — system-only, absent from the chat tool's
 *     enum: sign-in raises it, no model can.
 *   - `workspaceId` is the `fleet` sentinel, the same one missed captures use: a
 *     refused sign-up belongs to no tenant — that is the whole point of it.
 *   - `holdingId` is `provisioning-cap:<dayKey>`, the SUBJECT rather than a
 *     holding. The dedup key (`workspace + holding + category`) is then «this
 *     day's cap»: the first refusal of a day mints the alert and every later one
 *     accumulates an occurrence, so the occurrence count reads as «how many
 *     sign-ups were turned away that day». The next day is a new incident.
 *   - The payload carries the day, the cap and the count — and never the
 *     identity that was refused. The builder is not even given it.
 */

/** Sentinel workspace id: a refused sign-up is fleet-wide (same as missed captures). */
export const PROVISIONING_CAP_ALERT_WORKSPACE_ID = "fleet";

const HOLDING_ID_PREFIX = "provisioning-cap:";

/** Why the sign-up was refused: the day is full, or the cap could not be read. */
export type ProvisioningCapRefusalReason = "cap_reached" | "misconfigured";

/** The forensic payload of one refused sign-up (#1175). */
export interface ProvisioningCapPayload {
  category: "provisioning_cap";
  /** The maintainer-facing diagnosis, already spelled out in words. */
  summary: string;
  reason: ProvisioningCapRefusalReason;
  /** The UTC day whose cap refused the sign-up (`YYYY-MM-DD`). */
  dayKey: string;
  /** The cap in force (0 when closed, or when misconfigured — it fails closed). */
  dailyCap: number;
  /** Workspaces that day had already handed out. */
  used: number;
  /** The env value that failed to parse — only for `misconfigured`. */
  configuredValue?: string;
  detectedAt: string;
}

/** The day behind a provisioning-cap alert's sentinel holding id, or null. */
export function provisioningCapDayFromHoldingId(holdingId: string): string | null {
  return holdingId.startsWith(HOLDING_ID_PREFIX)
    ? holdingId.slice(HOLDING_ID_PREFIX.length)
    : null;
}

/** `2026-03-14` → `14-03-2026`; the raw string when it is not a day key. */
export function provisioningCapDayLabel(dayKey: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dayKey);
  return match ? `${match[3]}-${match[2]}-${match[1]}` : dayKey;
}

export function buildProvisioningCapAlert(input: {
  refusal: { dayKey: string; dailyCap: number; used: number };
  reason: ProvisioningCapRefusalReason;
  /** The raw env value, for a misconfigured cap. */
  configuredValue?: string;
  detectedAt: string;
}): RaiseMaintainerAlertInput & { payload: ProvisioningCapPayload } {
  const { refusal, reason, detectedAt } = input;
  const configuredValue =
    reason === "misconfigured" ? (input.configuredValue ?? "") : null;
  return {
    category: "provisioning_cap",
    holdingId: `${HOLDING_ID_PREFIX}${refusal.dayKey}`,
    occurredAt: detectedAt,
    payload: {
      category: "provisioning_cap",
      dailyCap: refusal.dailyCap,
      dayKey: refusal.dayKey,
      detectedAt,
      reason,
      summary: provisioningCapSummary(refusal, configuredValue),
      used: refusal.used,
      ...(configuredValue === null ? {} : { configuredValue }),
    },
    workspaceId: PROVISIONING_CAP_ALERT_WORKSPACE_ID,
  };
}

function provisioningCapSummary(
  refusal: { dayKey: string; dailyCap: number; used: number },
  configuredValue: string | null,
): string {
  const day = provisioningCapDayLabel(refusal.dayKey);
  if (configuredValue !== null) {
    return (
      `Alta rechazada el ${day}: ${DAILY_PROVISIONING_CAP_ENV} vale «${configuredValue}», ` +
      "que no es un entero no negativo, así que el cupo falla cerrado y no se abre " +
      "ningún workspace nuevo. Los usuarios existentes entran con normalidad. " +
      "Corrige la variable (o bórrala para registro abierto) y redespliega."
    );
  }
  if (refusal.dailyCap === 0) {
    return (
      `Alta rechazada el ${day}: el cupo diario de altas está a 0, es decir, el ` +
      "registro de workspaces nuevos está cerrado. Los usuarios existentes entran " +
      "con normalidad."
    );
  }
  return (
    `Alta rechazada el ${day}: el cupo diario de altas (${refusal.dailyCap}) ya está ` +
    `cubierto con ${refusal.used} workspace(s) nuevo(s). A la persona se le ha dicho ` +
    "que hoy estamos llenos y que vuelva mañana; los usuarios existentes entran con " +
    "normalidad. Cada ocurrencia de esta alerta es un alta rechazada hoy."
  );
}

/**
 * Whether a stored occurrence payload is a provisioning-cap one. Structural, not
 * trusting: payloads are opaque JSON frozen at raise time.
 */
export function isProvisioningCapPayload(
  value: unknown,
): value is ProvisioningCapPayload {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as Partial<ProvisioningCapPayload>;
  return (
    candidate.category === "provisioning_cap" &&
    typeof candidate.summary === "string" &&
    (candidate.reason === "cap_reached" || candidate.reason === "misconfigured") &&
    typeof candidate.dayKey === "string" &&
    typeof candidate.dailyCap === "number" &&
    typeof candidate.used === "number"
  );
}
