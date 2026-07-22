/**
 * The free plan's monthly assistant courtesy quota (PRD #1160 S2, #1162) — the
 * product limit that sits on top of the ADR 0051 hourly operational throttle.
 * «Lo que tecleas tú, gratis para siempre»: a free workspace keeps a generous
 * but bounded number of assistant turns a month, WITHOUT attachments (those are
 * premium ingestion, gated at the attachment seam). When it runs out the
 * assistant says so honestly — never a silent failure.
 *
 * Pure policy — the counter lives in the control plane
 * (`recordAssistantCourtesyUse`); this module is the window + threshold half, so
 * it unit-tests without a database. The figure lives in the commercial-launch
 * plan (`.local/plan-salida-comercial.md` §1): ~10 assistant turns / month.
 *
 * Applies ONLY to authenticated `free` workspaces. Trial/premium answer to the
 * token budget (S3, #1163), and demo/local bypass entirely (they resolve to
 * premium in `effectivePlanForTarget`).
 */
export const FREE_ASSISTANT_MONTHLY_QUOTA = 10;

/** The ISO timestamp's calendar-month bucket, e.g. "2026-07". */
export function courtesyMonthWindow(nowIso: string): string {
  return nowIso.slice(0, 7);
}

/**
 * Increment-then-check, mirroring the ADR 0051 rate limit: the running count is
 * compared AFTER counting this turn, so the Nth turn (count === quota) still
 * passes and the (N+1)th is the first refused. `null` means unmetered (local
 * dev with no control plane) — never exhausted.
 */
export function isCourtesyQuotaExhausted(count: number | null): boolean {
  return count !== null && count > FREE_ASSISTANT_MONTHLY_QUOTA;
}
