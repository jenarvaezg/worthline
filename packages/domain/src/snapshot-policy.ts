/**
 * Snapshot capture policy — pure domain logic for automatic snapshot management.
 *
 * Snapshots are not a user act: at most one per scope per day, the day's latest
 * capture winning. The monthly close is derived as the last snapshot of each
 * calendar month — never declared by the user.
 *
 * See ADR 0005.
 */

export interface SnapshotPolicyEntry {
  id: string;
  dateKey: string;
  monthKey: string;
  scopeId: string;
}

export interface CaptureDecision {
  /** Whether a new snapshot should be captured now. */
  shouldCapture: boolean;
  /**
   * When present, the existing snapshot for today that the new capture
   * should replace (same-day latest-wins semantics).
   */
  replacesId?: string;
}

/**
 * Decides whether to capture a snapshot for `scopeId` on `today` and
 * whether it should replace an existing same-day snapshot.
 *
 * - First capture of the day → `{ shouldCapture: true }` (no replacesId).
 * - Recapture on same day → `{ shouldCapture: true, replacesId: <existing id> }`.
 */
export function planSnapshotCapture(
  existingSnapshots: SnapshotPolicyEntry[],
  scopeId: string,
  today: string,
): CaptureDecision {
  const todaySnapshot = existingSnapshots.find(
    (s) => s.scopeId === scopeId && s.dateKey === today,
  );

  if (todaySnapshot) {
    return { shouldCapture: true, replacesId: todaySnapshot.id };
  }

  return { shouldCapture: true };
}

/**
 * Derives the monthly close for each calendar month from a list of snapshots.
 * The monthly close is the last snapshot (by dateKey, lexicographic) in each month.
 *
 * Returns a Map from monthKey ("YYYY-MM") to the snapshot id of the close.
 *
 * Snapshots from multiple scopes can be passed — the derivation is purely
 * date-based and scoped externally by the caller filtering by scopeId first.
 */
export function deriveMonthlyCloses(
  snapshots: readonly SnapshotPolicyEntry[],
): Map<string, string> {
  const closeByMonth = new Map<string, string>();

  // Sort ascending by dateKey so later entries overwrite earlier ones.
  const sorted = [...snapshots].sort((a, b) => a.dateKey.localeCompare(b.dateKey));

  for (const snapshot of sorted) {
    closeByMonth.set(snapshot.monthKey, snapshot.id);
  }

  return closeByMonth;
}

/** Whether "YYYY-MM-DD" falls on the last calendar day of its month. */
function isLastCalendarDayOfMonth(dateKey: string): boolean {
  const parts = dateKey.split("-");
  const year = Number(parts[0]);
  const month = Number(parts[1]);
  const day = Number(parts[2]);
  // Day 0 of the next month is the last day of this one.
  return day === new Date(year, month, 0).getDate();
}

/**
 * Derives the snapshot ids that are CONFIRMED monthly closes as of `today`.
 *
 * A month's close (its last snapshot, per `deriveMonthlyCloses`) is confirmed
 * only once the month has fully elapsed — i.e. its `monthKey` is strictly before
 * `today`'s month, or the close snapshot literally falls on the last calendar
 * day of its month. The in-progress month's trailing snapshot is therefore NOT
 * shown as a close mid-month (#270): a snapshot taken today, on a day that is not
 * month-end, is just the latest capture, not "Cierre de mes".
 *
 * `today` is a "YYYY-MM-DD" date key, passed in to keep the function pure.
 * Scope isolation is the caller's job — filter by scopeId first, as with
 * `deriveMonthlyCloses`.
 */
export function deriveConfirmedMonthlyCloseIds(
  snapshots: readonly SnapshotPolicyEntry[],
  today: string,
): Set<string> {
  const dateKeyById = new Map(snapshots.map((s) => [s.id, s.dateKey]));
  const todayMonthKey = today.slice(0, 7);

  const confirmed = new Set<string>();
  for (const [monthKey, id] of deriveMonthlyCloses(snapshots)) {
    const dateKey = dateKeyById.get(id);
    if (dateKey === undefined) continue;
    if (monthKey < todayMonthKey || isLastCalendarDayOfMonth(dateKey)) {
      confirmed.add(id);
    }
  }
  return confirmed;
}
