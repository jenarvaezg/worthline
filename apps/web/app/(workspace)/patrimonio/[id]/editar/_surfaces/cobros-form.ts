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
import { parseDecimalToMinor, parseDecimalToMinorStrict } from "@worthline/domain";
import type { LeaseTermsFields, ParsedLeaseTerms } from "./lease-terms-form";
import { parseLeaseTerms } from "./lease-terms-form";

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

/**
 * The raw schedule fields lifted straight off the form.
 *
 * The lease terms ride along (#1521) and are optional in the same sense the expenses
 * are: an empty select is «no lo he dicho», so a form that never showed them (a
 * coupon, a dividend — anything that is not a rented property) parses to three nulls
 * and declares nothing.
 */
export interface PayoutScheduleFields extends LeaseTermsFields {
  label: string;
  amount: string;
  cadence: string;
  startISO: string;
  /** Optional end date; "" means "no end". */
  endISO: string;
  /**
   * What the income costs, same cadence as `amount` (#1448). "" means **not
   * declared** — and that is not the same as "0": with no declaration the FIRE
   * return of a rented property keeps its tier default instead of sealing a gross
   * yield, so the empty string can never be coerced to a zero here.
   */
  expenses: string;
}

/** A validated schedule write — holdingId is added by the action. */
export interface ParsedPayoutSchedule extends ParsedLeaseTerms {
  label: string;
  amountMinor: number;
  cadence: PayoutCadence;
  startISO: string;
  endISO?: string;
  /** Present only when the user declared it; absent means "not declared". */
  expensesMinor?: number;
}

export type PayoutScheduleResult =
  | { ok: true; schedule: ParsedPayoutSchedule }
  | { ok: false; error: string };

/**
 * Parse a declared-expenses amount: `null` for an empty field (not declared / a
 * declaration being withdrawn), a non-negative minor amount otherwise. Costs ABOVE
 * the income are accepted on purpose — a flat that costs more than it earns is a
 * real, declarable situation, and the FIRE rate shows it as the negative yield it
 * is instead of rejecting the data.
 */
export function parseScheduleExpenses(
  raw: string,
): { ok: true; expensesMinor: number | null } | { ok: false; error: string } {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { ok: true, expensesMinor: null };
  }
  const expensesMinor = parseDecimalToMinorStrict(trimmed);
  if (expensesMinor === null) {
    return { ok: false, error: "Introduce unos gastos válidos (o déjalo vacío)." };
  }
  if (expensesMinor < 0) {
    return { ok: false, error: "Los gastos no pueden ser negativos." };
  }
  return { ok: true, expensesMinor };
}

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
  const expenses = parseScheduleExpenses(fields.expenses);
  if (!expenses.ok) {
    return { ok: false, error: expenses.error };
  }
  const lease = parseLeaseTerms(fields);
  if (!lease.ok) {
    return { ok: false, error: lease.error };
  }
  return {
    ok: true,
    schedule: {
      label,
      amountMinor,
      cadence,
      startISO,
      ...(endISO ? { endISO } : {}),
      ...(expenses.expensesMinor === null
        ? {}
        : { expensesMinor: expenses.expensesMinor }),
      ...lease.terms,
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
