/**
 * What a pass of «Poner al día» ends in (#1884, ADR 0114 decision 7), as it is kept
 * on the connection's sync state and read back by the panel, the band and the cron.
 * Client-safe: no store, no client.
 *
 * Every kind carries only words of ours and instants: never an amount, an ISIN nor
 * an identifier (decision 8). The units check is the one exception that carries
 * figures, the units of the user's own holding, and it lives in its own column.
 */
import type { DecimalString } from "@worthline/domain";
import { z } from "zod";

/** The steps of a pass, in order, as the panel shows them live. */
export const MYINVESTOR_SYNC_STEPS = [
  { key: "login", label: "Entrar en MyInvestor" },
  { key: "positions", label: "Posiciones y saldo" },
  { key: "orders", label: "Órdenes desde la última buena" },
  { key: "plans", label: "Planes y aportaciones" },
  { key: "check", label: "Comprobar participaciones" },
] as const;

export type MyInvestorSyncStep = (typeof MYINVESTOR_SYNC_STEPS)[number]["key"];

export function isMyInvestorSyncStep(value: unknown): value is MyInvestorSyncStep {
  return MYINVESTOR_SYNC_STEPS.some((step) => step.key === value);
}

/** What a pass that reached MyInvestor (or its login limit) ended in. */
export type MyInvestorSyncOutcome =
  | {
      readonly kind: "ok";
      readonly at: string;
      /** New operations the pass applied. */
      readonly applied: number;
      /** Linked holdings whose units do not square with MyInvestor's. */
      readonly mismatches: number;
      /** «Resincronizar todo»: the whole history was read again. */
      readonly resynced: boolean;
    }
  /** The password was rejected: a saved one is deleted; the cron stops. */
  | { readonly kind: "password_rejected"; readonly at: string }
  /** The third rejection of the day: locked until the next day. */
  | { readonly kind: "locked"; readonly at: string; readonly until: string }
  /** Rejected with no reason (`SECURITY_001`): a 24-hour pause. */
  | { readonly kind: "rejected_no_reason"; readonly at: string; readonly until: string }
  /** The device is no longer trusted: the cron stops until the phone is verified. */
  | { readonly kind: "sms_required"; readonly at: string }
  /** Network or WAF, after the client's retries. */
  | { readonly kind: "network"; readonly at: string }
  /** Anything else MyInvestor or the relay answered that a pass cannot use. */
  | { readonly kind: "failed"; readonly at: string }
  /** The day already spent its 10 logins. */
  | { readonly kind: "limit"; readonly at: string };

export type MyInvestorSyncOutcomeKind = MyInvestorSyncOutcome["kind"];

const at = z.string().min(1);
const outcomeSchema = z.discriminatedUnion("kind", [
  z.object({
    applied: z.number().int().nonnegative(),
    at,
    kind: z.literal("ok"),
    mismatches: z.number().int().nonnegative(),
    resynced: z.boolean(),
  }),
  z.object({ at, kind: z.literal("password_rejected") }),
  z.object({ at, kind: z.literal("locked"), until: at }),
  z.object({ at, kind: z.literal("rejected_no_reason"), until: at }),
  z.object({ at, kind: z.literal("sms_required") }),
  z.object({ at, kind: z.literal("network") }),
  z.object({ at, kind: z.literal("failed") }),
  z.object({ at, kind: z.literal("limit") }),
]);

function parseJson(json: string | null): unknown {
  if (json === null) return null;
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

export function serializeMyInvestorSyncOutcome(outcome: MyInvestorSyncOutcome): string {
  return JSON.stringify(outcome);
}

/** The stored outcome, or null when there is none or it is not one this version reads. */
export function parseMyInvestorSyncOutcome(
  json: string | null,
): MyInvestorSyncOutcome | null {
  const parsed = outcomeSchema.safeParse(parseJson(json));
  return parsed.success ? parsed.data : null;
}

/** A linked holding whose units do not square, as the check keeps it (P8). */
export interface MyInvestorUnitsCheckEntry {
  readonly assetId: string;
  readonly productKey: string;
  readonly bookUnits: DecimalString;
  readonly sourceUnits: DecimalString;
  readonly difference: DecimalString;
}

const unitsCheckSchema = z.array(
  z.object({
    assetId: at,
    bookUnits: at,
    difference: at,
    productKey: at,
    sourceUnits: at,
  }),
);

export function serializeMyInvestorUnitsCheck(
  entries: readonly MyInvestorUnitsCheckEntry[],
): string {
  return JSON.stringify(entries);
}

/** The last units check; empty when it squared, was never run or does not parse. */
export function parseMyInvestorUnitsCheck(
  json: string | null,
): MyInvestorUnitsCheckEntry[] {
  const parsed = unitsCheckSchema.safeParse(parseJson(json));
  return parsed.success ? parsed.data : [];
}
