/**
 * `YYYY-MM-DD` → `DD/MM/YYYY`, without touching `Date` (no timezone surprises).
 *
 * A leaf module on purpose. The assistant needs this in three places — the
 * amortization-backed copy of `early-repayment-impact`, the attachment preview and
 * the reconcile row (#1373) — and two of them render inside the `"use client"`
 * layer. Importing the amortization module across that boundary for string slicing
 * is a bundle bet this repo's weight tripwire does not need taken, so the slicing
 * lives here, where every caller can have it for nothing.
 */
export function formatIsoDayEs(isoDay: string): string {
  const [year, month, day] = isoDay.split("-");
  return `${day}/${month}/${year}`;
}
