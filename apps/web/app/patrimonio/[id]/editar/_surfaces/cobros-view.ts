/**
 * Pure derivation + display maths for the "Cobros" grid (PRD #652 S1, #656).
 *
 * Folds the winning S0 prototype (variant C2) onto the real domain: it merges
 * one-off payouts with each schedule's derived occurrences (via the domain's
 * `deriveScheduleOccurrences` — never re-derived here), groups them by month, spans
 * the year range, and computes the non-saturating heatmap tint. Kept pure so the
 * server section and the client grid island share ONE source of truth and it stays
 * unit-testable without React (interaction-patterns §7).
 */

import type { Payout, PayoutSchedule } from "@worthline/domain";
import { deriveScheduleOccurrences } from "@worthline/domain";

/** A payout row ready to render — a recorded one-off or a derived occurrence. */
export interface CobroRow {
  key: string;
  dateISO: string;
  amountMinor: number;
  kind: "oneoff" | "derived";
  /** The one-off's note (may be "") or the schedule's label. */
  label: string;
  /** The schedule this row derives from, or null for a one-off. */
  scheduleId: string | null;
}

/** Merge one-offs + every schedule's derived occurrences, newest first. */
export function buildCobroRows(
  payouts: readonly Payout[],
  schedules: readonly PayoutSchedule[],
  todayISO: string,
): CobroRow[] {
  const derived: CobroRow[] = schedules.flatMap((schedule) =>
    deriveScheduleOccurrences(schedule, todayISO).map((occurrence) => ({
      key: `${schedule.id}:${occurrence.dateISO}`,
      dateISO: occurrence.dateISO,
      amountMinor: occurrence.amountMinor,
      kind: "derived" as const,
      label: occurrence.label,
      scheduleId: schedule.id,
    })),
  );
  const oneOffs: CobroRow[] = payouts.map((payout) => ({
    key: `oneoff:${payout.id}`,
    dateISO: payout.dateISO,
    amountMinor: payout.amountMinor,
    kind: "oneoff" as const,
    label: payout.note ?? "",
    scheduleId: null,
  }));
  return [...derived, ...oneOffs].sort((a, b) => (a.dateISO < b.dateISO ? 1 : -1));
}

/** Month key (YYYY-MM) → the rows that fall in it. */
export function rowsByMonth(rows: readonly CobroRow[]): Map<string, CobroRow[]> {
  const map = new Map<string, CobroRow[]>();
  for (const row of rows) {
    const key = row.dateISO.slice(0, 7);
    map.set(key, [...(map.get(key) ?? []), row]);
  }
  return map;
}

/** The years spanned by the rows, ascending, always including the current year. */
export function availableYears(rows: readonly CobroRow[], todayISO: string): number[] {
  const current = Number(todayISO.slice(0, 4));
  let min = current;
  for (const row of rows) min = Math.min(min, Number(row.dateISO.slice(0, 4)));
  const years: number[] = [];
  for (let year = min; year <= current; year += 1) years.push(year);
  return years;
}

/**
 * Non-saturating heatmap alpha. Colour encodes "above the normal month", not
 * absolute size (S0 C2 feedback): a flat rent (min==max) reads as a calm uniform
 * light, never a dark slab; with spread, the norm stays light and only the big
 * months darken. Soft 0.1–0.6 range; a flat window pins to 0.16.
 */
export function heatAlpha(value: number, min: number, max: number): number {
  if (value <= 0) return 0;
  if (max <= min) return 0.16;
  return 0.1 + 0.5 * ((value - min) / (max - min));
}

/** Sum the minor-unit amounts of a row set. */
export function sumMinor(rows: readonly CobroRow[]): number {
  return rows.reduce((total, row) => total + row.amountMinor, 0);
}
