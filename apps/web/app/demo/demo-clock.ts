/**
 * Demo clock helpers (PRD #297, ADR 0029/0024). The demo's "now" is pinned by
 * `WORTHLINE_DEMO_NOW`, carried on the resolved {@link DemoContext}. These turn
 * that raw value into the `Date` / date-key the app and seed read. The demo cares
 * about the configured calendar day, not about UTC midnight: a value such as
 * `2026-06-20T00:30:00+02:00` must still seed and render as 2026-06-20.
 */

const DATE_KEY_PATTERN = /^(\d{4}-\d{2}-\d{2})(?:$|[T\s])/;

function isValidDateKey(dateKey: string): boolean {
  const parsed = new Date(`${dateKey}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === dateKey;
}

function localDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function explicitDateKey(now: string): string | null {
  const match = DATE_KEY_PATTERN.exec(now.trim());
  const dateKey = match?.[1];
  return dateKey && isValidDateKey(dateKey) ? dateKey : null;
}

function demoNoonUtc(dateKey: string): Date {
  return new Date(`${dateKey}T12:00:00.000Z`);
}

/** The pinned instant as a Date, falling back to the real clock when unpinned. */
export function demoNowDate(now: string): Date {
  const configuredDay = explicitDateKey(now);
  if (configuredDay) {
    return demoNoonUtc(configuredDay);
  }

  const parsed = now.trim() ? new Date(now) : null;
  if (parsed && !Number.isNaN(parsed.getTime())) {
    return demoNoonUtc(localDateKey(parsed));
  }

  return demoNoonUtc(localDateKey(new Date()));
}

/** The pinned instant as a YYYY-MM-DD date-key (the seed's `asOf`). */
export function demoAsOfDateKey(now: string): string {
  return demoNowDate(now).toISOString().slice(0, 10);
}
