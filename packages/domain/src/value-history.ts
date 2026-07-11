/**
 * Manual value history: the audit trail of declared values for a holding valued
 * by hand, and the lookup that resolves the value in force on a date. A leaf
 * module so the holding-valuation dispatcher and historical reconstruction can
 * both depend on it without forming an import cycle.
 */

/** One declared value of a manual holding on a date, from the audit history. */
export interface ManualValuePoint {
  /** YYYY-MM-DD the value applies from. */
  dateKey: string;
  valueMinor: number;
}

/** The most recent value with dateKey ≤ target, or undefined if none reaches back. */
export function lastKnownValueAtDate(
  points: readonly ManualValuePoint[] | undefined,
  targetDate: string,
): number | undefined {
  if (!points || points.length === 0) return undefined;

  let resolved: number | undefined;
  for (const point of points) {
    if (point.dateKey <= targetDate) {
      resolved = point.valueMinor;
    }
  }
  return resolved;
}

/** The latest declared-value date in history, or `createdAtIso` as fallback. */
export function lastManualValueUpdateDateKey(
  history: readonly ManualValuePoint[] | undefined,
  createdAtIso: string | undefined,
): string | undefined {
  if (history !== undefined && history.length > 0) {
    return history.reduce(
      (latest, point) => (point.dateKey > latest ? point.dateKey : latest),
      history[0]!.dateKey,
    );
  }

  if (createdAtIso === undefined || createdAtIso.length < 10) {
    return undefined;
  }

  return createdAtIso.slice(0, 10);
}
