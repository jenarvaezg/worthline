import { DAILY_PROVISIONING_CAP_ENV } from "@web/provisioning-cap";
import {
  type DailyProvisioningCapRefusal,
  dailyProvisioningLimit,
  type RaiseMaintainerAlertInput,
} from "@worthline/db";

/**
 * The provisioning-cap maintainer-alert contract (#1175, ADR 0064 amended).
 *
 * When the daily provisioning cap turns a new identity away, the refused person
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
 *   - The payload carries the day, the cause, the limit and the count — and
 *     never the identity that was refused. The builder is not even given it.
 */

/** Sentinel workspace id: a refused sign-up is fleet-wide (same as missed captures). */
export const PROVISIONING_CAP_ALERT_WORKSPACE_ID = "fleet";

const HOLDING_ID_PREFIX = "provisioning-cap:";

/**
 * Why the cap refused, in the maintainer's terms: the day is full, registration
 * is closed on purpose (limit 0), the variable is unreadable, or a production
 * deploy is missing it.
 */
export type ProvisioningCapCause =
  | "cap_reached"
  | "closed"
  | "misconfigured"
  | "unset_in_production";

/** The forensic payload of one refused sign-up (#1175). */
export interface ProvisioningCapPayload {
  category: "provisioning_cap";
  /** The maintainer-facing diagnosis, already spelled out in words. */
  summary: string;
  cause: ProvisioningCapCause;
  /** The UTC day whose cap refused the sign-up (`YYYY-MM-DD`). */
  dayKey: string;
  /** The limit enforced — 0 for every fail-closed cause. */
  limit: number;
  /** Workspaces that day had already provisioned. */
  provisionedToday: number;
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

function causeOf(refusal: DailyProvisioningCapRefusal): ProvisioningCapCause {
  switch (refusal.policy.kind) {
    case "limited":
      return refusal.policy.limit === 0 ? "closed" : "cap_reached";
    case "misconfigured":
      return "misconfigured";
    case "unset":
      return "unset_in_production";
  }
}

export function buildProvisioningCapAlert(input: {
  refusal: DailyProvisioningCapRefusal;
  detectedAt: string;
}): RaiseMaintainerAlertInput & { payload: ProvisioningCapPayload } {
  const { refusal, detectedAt } = input;
  const { policy } = refusal;
  return {
    category: "provisioning_cap",
    holdingId: `${HOLDING_ID_PREFIX}${refusal.dayKey}`,
    occurredAt: detectedAt,
    payload: {
      category: "provisioning_cap",
      cause: causeOf(refusal),
      dayKey: refusal.dayKey,
      detectedAt,
      limit: dailyProvisioningLimit(policy),
      provisionedToday: refusal.provisionedToday,
      summary: provisioningCapSummary(refusal),
      ...(policy.kind === "misconfigured"
        ? { configuredValue: policy.configuredValue }
        : {}),
    },
    workspaceId: PROVISIONING_CAP_ALERT_WORKSPACE_ID,
  };
}

const EXISTING_USERS_UNAFFECTED = "Los usuarios existentes entran con normalidad.";

function provisioningCapSummary(refusal: DailyProvisioningCapRefusal): string {
  const day = provisioningCapDayLabel(refusal.dayKey);
  const { policy } = refusal;
  switch (policy.kind) {
    case "unset":
      return (
        `Alta rechazada el ${day}: este despliegue de producción no define ` +
        `${DAILY_PROVISIONING_CAP_ENV}, y en producción un cupo sin definir falla ` +
        "cerrado igual que uno ilegible, así que no se abre ningún workspace nuevo. " +
        `${EXISTING_USERS_UNAFFECTED} Define la variable y redespliega.`
      );
    case "misconfigured":
      return (
        `Alta rechazada el ${day}: ${DAILY_PROVISIONING_CAP_ENV} vale ` +
        `«${policy.configuredValue}», que no es un entero no negativo, así que el ` +
        "cupo falla cerrado y no se abre ningún workspace nuevo. " +
        `${EXISTING_USERS_UNAFFECTED} Corrige la variable y redespliega.`
      );
    case "limited":
      if (policy.limit === 0) {
        return (
          `Alta rechazada el ${day}: el cupo diario de altas está a 0, es decir, ` +
          `el registro de workspaces nuevos está cerrado. ${EXISTING_USERS_UNAFFECTED}`
        );
      }
      return (
        `Alta rechazada el ${day}: el cupo diario de altas (${policy.limit}) ya está ` +
        `cubierto con ${refusal.provisionedToday} workspace(s) nuevo(s). A la persona ` +
        "se le ha dicho que hoy estamos llenos y que vuelva mañana. " +
        `${EXISTING_USERS_UNAFFECTED} Cada ocurrencia de esta alerta es un alta ` +
        "rechazada ese día."
      );
  }
}

const CAUSES: ReadonlySet<string> = new Set<ProvisioningCapCause>([
  "cap_reached",
  "closed",
  "misconfigured",
  "unset_in_production",
]);

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
    typeof candidate.cause === "string" &&
    CAUSES.has(candidate.cause) &&
    typeof candidate.dayKey === "string" &&
    typeof candidate.limit === "number" &&
    typeof candidate.provisionedToday === "number"
  );
}
