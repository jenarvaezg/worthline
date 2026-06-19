/**
 * Demo clock helpers (PRD #297, ADR 0023/0024). The demo's "now" is pinned by
 * `WORTHLINE_DEMO_NOW`, carried on the resolved {@link DemoContext}. These turn
 * that raw value into the `Date` / date-key the app and seed read. A missing or
 * unparseable value degrades to the real clock — the demo keeps working, just
 * not frozen — rather than crashing on an `Invalid Date`.
 */

/** The pinned instant as a Date, falling back to the real clock when unpinned. */
export function demoNowDate(now: string): Date {
  if (now) {
    const parsed = new Date(now);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return new Date();
}

/** The pinned instant as a YYYY-MM-DD date-key (the seed's `asOf`). */
export function demoAsOfDateKey(now: string): string {
  return demoNowDate(now).toISOString().slice(0, 10);
}
