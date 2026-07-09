/**
 * Pure payout-entry form logic (PRD #652 S1, #656, ADR 0054).
 *
 * All parsing + validation for the "Cobros" hand-entry surface lives here
 * (interaction-patterns §7): the field map → a one-off payout write, the field map
 * → a payout-schedule write, and the per-occurrence exclusion toggle. A payout is a
 * pure attribution record — it touches no figure, no snapshot, no ripple — so this
 * module only shapes what `store.payouts` persists. No React, no DB, no Next.js:
 * the section component and the server actions are thin glue over this.
 */

import type { PayoutCadence } from "@worthline/domain";
import { parseDecimalToMinor } from "@worthline/domain";

/** The cadences in render order, with their Spanish labels. */
export const PAYOUT_CADENCE_LABELS: ReadonlyArray<{
  cadence: PayoutCadence;
  label: string;
}> = [
  { cadence: "monthly", label: "Mensual" },
  { cadence: "quarterly", label: "Trimestral" },
  { cadence: "annual", label: "Anual" },
  { cadence: "weekly", label: "Semanal" },
];

const CADENCES: readonly PayoutCadence[] = ["weekly", "monthly", "quarterly", "annual"];

/** A well-formed ISO calendar date (YYYY-MM-DD) that names a real day. */
function isValidISODate(raw: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return false;
  const ms = Date.parse(`${raw}T00:00:00.000Z`);
  if (Number.isNaN(ms)) return false;
  // Round-trip so an overflowing day (2026-02-30 → March) is rejected, not clamped.
  return new Date(ms).toISOString().slice(0, 10) === raw;
}

function isPayoutCadence(raw: string): raw is PayoutCadence {
  return (CADENCES as readonly string[]).includes(raw);
}

// ── one-off payout ────────────────────────────────────────────────────────────

/** The raw one-off fields lifted straight off the form. */
export interface PayoutFields {
  dateISO: string;
  /** es-ES decimal amount, e.g. "1.234,56". */
  amount: string;
  note: string;
}

/** A validated one-off payout write — holdingId is added by the action. */
export interface ParsedPayout {
  dateISO: string;
  amountMinor: number;
  note?: string;
}

export type PayoutResult =
  | { ok: true; payout: ParsedPayout }
  | { ok: false; error: string };

/** Parse + validate a one-off payout: positive amount, valid date, optional note. */
export function buildPayoutResult(fields: PayoutFields): PayoutResult {
  const dateISO = fields.dateISO.trim();
  if (!isValidISODate(dateISO)) {
    return { ok: false, error: "Introduce una fecha válida para el cobro." };
  }
  const amountMinor = parseDecimalToMinor(fields.amount);
  if (amountMinor <= 0) {
    return { ok: false, error: "Introduce un importe mayor que cero." };
  }
  const note = fields.note.trim();
  return { ok: true, payout: { dateISO, amountMinor, ...(note ? { note } : {}) } };
}

// ── payout schedule ─────────────────────────────────────────────────────────

/** The raw schedule fields lifted straight off the form. */
export interface PayoutScheduleFields {
  label: string;
  amount: string;
  cadence: string;
  startISO: string;
  /** Optional end date; "" means "no end". */
  endISO: string;
}

/** A validated schedule write — holdingId is added by the action. */
export interface ParsedPayoutSchedule {
  label: string;
  amountMinor: number;
  cadence: PayoutCadence;
  startISO: string;
  endISO?: string;
}

export type PayoutScheduleResult =
  | { ok: true; schedule: ParsedPayoutSchedule }
  | { ok: false; error: string };

/** Parse + validate a declared schedule: label, positive amount, cadence, dates. */
export function buildPayoutScheduleResult(
  fields: PayoutScheduleFields,
): PayoutScheduleResult {
  const label = fields.label.trim();
  if (!label) {
    return { ok: false, error: "Introduce un concepto para el cobro recurrente." };
  }
  const amountMinor = parseDecimalToMinor(fields.amount);
  if (amountMinor <= 0) {
    return { ok: false, error: "Introduce un importe mayor que cero." };
  }
  const cadence = fields.cadence.trim();
  if (!isPayoutCadence(cadence)) {
    return { ok: false, error: "Selecciona una cadencia válida." };
  }
  const startISO = fields.startISO.trim();
  if (!isValidISODate(startISO)) {
    return { ok: false, error: "Introduce una fecha de inicio válida." };
  }
  const endISO = fields.endISO.trim();
  if (endISO) {
    if (!isValidISODate(endISO)) {
      return { ok: false, error: "Introduce una fecha de fin válida." };
    }
    if (endISO < startISO) {
      return { ok: false, error: "La fecha de fin no puede ser anterior al inicio." };
    }
  }
  return {
    ok: true,
    schedule: {
      label,
      amountMinor,
      cadence,
      startISO,
      ...(endISO ? { endISO } : {}),
    },
  };
}

// ── exclusion toggle ──────────────────────────────────────────────────────────

/** Add or remove a single occurrence date from a schedule's exclusion list. */
export function toggleExclusion(
  exclusions: readonly string[],
  dateISO: string,
): string[] {
  return exclusions.includes(dateISO)
    ? exclusions.filter((d) => d !== dateISO)
    : [...exclusions, dateISO];
}
