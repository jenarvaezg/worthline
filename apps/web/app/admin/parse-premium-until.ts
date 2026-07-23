/**
 * The premium-grant date contract (PRD #1160 S4, #1164), kept in its own module
 * (NOT the "use server" action file, whose every export must be an async
 * function). Pure and injectable-`now`, so the future check is deterministic
 * under test.
 *
 *  - Empty → an INDEFINITE grant (`premiumUntil: null`) — the beta/lifetime carril.
 *  - A `YYYY-MM-DD` strictly in the future → premium THROUGH the end of that day
 *    (UTC `23:59:59.999`), so a same-day grant still covers the whole day.
 *  - Anything else (malformed, an unreal calendar day, or today/past — which
 *    would grant a no-op) → invalid.
 */
export function parsePremiumUntil(
  raw: string,
  now: string,
): { ok: true; premiumUntil: string | null } | { ok: false } {
  const trimmed = raw.trim();
  if (trimmed === "") return { ok: true, premiumUntil: null };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return { ok: false };

  const endOfDay = `${trimmed}T23:59:59.999Z`;
  const parsed = Date.parse(endOfDay);
  if (Number.isNaN(parsed)) return { ok: false };
  // Reject an unreal calendar date: Date.parse rolls over out-of-range days
  // (2026-02-30 → Mar 2) instead of failing, so the only sound check is that the
  // parsed instant round-trips to the same UTC day the maintainer typed.
  if (new Date(parsed).toISOString().slice(0, 10) !== trimmed) return { ok: false };
  // Reject any window not strictly in the future — a past date would apply a
  // premium that derives back to free immediately, a confusing silent no-op.
  if (parsed <= Date.parse(now)) return { ok: false };
  return { ok: true, premiumUntil: endOfDay };
}
