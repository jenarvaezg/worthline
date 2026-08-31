/**
 * How this panel prints a calendar day: «1 sept 2026».
 *
 * UTC on purpose. Every date on this screen is a *declared day* — the end of a rent's
 * window, the date a contribution was recorded — never an instant, so reading it in the
 * viewer's timezone would slide it by one and turn «terminó el 1 sept» into «31 ago»
 * for anyone west of Greenwich.
 *
 * One formatter, shared: the panel, the rent-return copy and their tests all print the
 * same day the same way, and a change of format is one edit.
 */
const dayFormatter = new Intl.DateTimeFormat("es-ES", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});

/** `2026-09-01` → «1 sept 2026». */
export function formatDay(iso: string): string {
  return dayFormatter.format(new Date(`${iso}T00:00:00Z`));
}
