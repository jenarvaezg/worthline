/**
 * Pure payout-entry form logic (PRD #652 S1, #656, ADR 0054).
 *
 * The one-off half of the "Cobros" hand-entry surface (interaction-patterns §7):
 * the field map → a one-off payout write, and the per-occurrence exclusion toggle
 * of a declared income. A payout is a pure attribution record — it touches no
 * figure, no snapshot, no ripple — so this module only shapes what `store.payouts`
 * persists. Declaring the recurring income itself is the income door's
 * (`@web/_income/income-recurrence`, #1673).
 */

import { isValidISODate } from "@web/_income/income-recurrence";
import { parseDecimalToMinor } from "@worthline/domain";

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
