/**
 * Payouts — dividends, interest, rent as attribution records (ADR 0054).
 *
 * A payout is a dated record that one asset **holding** paid its owner an amount:
 * a pure attribution record, never a figure. It touches no net-worth figure, no
 * holding value, no snapshot, no ripple. This module owns the two rules that carry
 * real logic — deriving a schedule's past occurrences as truth, and aggregating the
 * trailing passive-income window — so no consumer re-derives them.
 *
 * Amounts are integer minor units (product constraint); a payout has no units
 * concept. Occurrences are derived on read, never materialized: a retroactive end
 * date removes a dead tail in one edit, a per-occurrence exclusion removes a single
 * unpaid month, and nothing is ever derived beyond today. Variable amounts are
 * entered as one-off payouts — a schedule is a fixed amount only.
 */

export type PayoutCadence = "weekly" | "monthly" | "quarterly" | "annual";

/** A one-off recorded payout: a variable dividend, an extraordinary distribution. */
export interface Payout {
  id: string;
  holdingId: string;
  dateISO: string;
  amountMinor: number;
  note?: string;
}

/** A declared fixed recurrence. Its occurrences are derived, never stored. */
export interface PayoutSchedule {
  id: string;
  holdingId: string;
  label: string;
  amountMinor: number;
  cadence: PayoutCadence;
  startISO: string;
  /** A retroactive end date removes the dead tail in one edit. Inclusive. */
  endISO: string | null;
  /** ISO dates removed one by one (an unpaid month). */
  exclusions: string[];
}

/** A single occurrence derived from a schedule. */
export interface DerivedPayout {
  scheduleId: string;
  holdingId: string;
  label: string;
  dateISO: string;
  amountMinor: number;
}

// ── calendar stepping (UTC, ISO in / ISO out — no TZ drift) ──────────────────

function parse(iso: string): Date {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1));
}

function toISO(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function daysInMonth(year: number, monthIdx: number): number {
  return new Date(Date.UTC(year, monthIdx + 1, 0)).getUTCDate();
}

/** Add `n` months, clamping the day to the target month's length (Jan 31 → Feb 28). */
function addMonths(date: Date, n: number): Date {
  const day = date.getUTCDate();
  const next = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + n, 1));
  next.setUTCDate(Math.min(day, daysInMonth(next.getUTCFullYear(), next.getUTCMonth())));
  return next;
}

const CADENCE_STEP_MONTHS: Record<Exclude<PayoutCadence, "weekly">, number> = {
  monthly: 1,
  quarterly: 3,
  annual: 12,
};

/**
 * The k-th occurrence, always measured from the original start so the anchor
 * day-of-month never drifts: a schedule that starts on the 31st recovers to the
 * 31st in long months even after clamping to 28/30 in short ones.
 */
function occurrenceAt(start: Date, cadence: PayoutCadence, k: number): Date {
  if (cadence === "weekly") return new Date(start.getTime() + 7 * 86_400_000 * k);
  return addMonths(start, CADENCE_STEP_MONTHS[cadence] * k);
}

// ── derivation ───────────────────────────────────────────────────────────────

/**
 * Derive a schedule's occurrences from its start up to (and including) today.
 * End date is inclusive; nothing is derived beyond today; a retroactive end caps
 * the series; exclusions drop single dates.
 */
export function deriveScheduleOccurrences(
  schedule: PayoutSchedule,
  todayISO: string,
): DerivedPayout[] {
  const today = parse(todayISO);
  const end = schedule.endISO ? parse(schedule.endISO) : null;
  // never beyond today, and never past a retroactive end
  const limit = end && end.getTime() < today.getTime() ? end : today;
  const exclusions = new Set(schedule.exclusions);

  const start = parse(schedule.startISO);
  const occurrences: DerivedPayout[] = [];
  // bounded loop: even a weekly schedule over a human lifetime stays well under this
  for (let k = 0; k < 20_000; k += 1) {
    const cursor = occurrenceAt(start, schedule.cadence, k);
    if (cursor.getTime() > limit.getTime()) break;
    const dateISO = toISO(cursor);
    if (!exclusions.has(dateISO)) {
      occurrences.push({
        scheduleId: schedule.id,
        holdingId: schedule.holdingId,
        label: schedule.label,
        dateISO,
        amountMinor: schedule.amountMinor,
      });
    }
  }
  return occurrences;
}

// ── returns integration (#657) ───────────────────────────────────────────────

/** A dated minor-unit amount: the shape a payout contributes to a return. */
export interface DatedAmount {
  dateISO: string;
  amountMinor: number;
}

/**
 * Every recorded payout up to `todayISO` (inclusive), grouped by holding id:
 * one-off payouts plus each schedule's derived occurrences. The upper bound
 * matches the return engine's terminal-value date — nothing dated after today
 * enters a return. This is the single place returns surfaces read payouts from,
 * so no consumer re-derives a schedule.
 */
export function collectHoldingPayouts(
  oneOffs: readonly Payout[],
  schedules: readonly PayoutSchedule[],
  todayISO: string,
): Map<string, DatedAmount[]> {
  const byHolding = new Map<string, DatedAmount[]>();
  const push = (holdingId: string, row: DatedAmount): void => {
    const rows = byHolding.get(holdingId);
    if (rows) {
      rows.push(row);
    } else {
      byHolding.set(holdingId, [row]);
    }
  };

  for (const payout of oneOffs) {
    if (payout.dateISO <= todayISO) {
      push(payout.holdingId, {
        dateISO: payout.dateISO,
        amountMinor: payout.amountMinor,
      });
    }
  }
  for (const schedule of schedules) {
    // deriveScheduleOccurrences already caps at today and honors end/exclusions.
    for (const occurrence of deriveScheduleOccurrences(schedule, todayISO)) {
      push(occurrence.holdingId, {
        dateISO: occurrence.dateISO,
        amountMinor: occurrence.amountMinor,
      });
    }
  }
  return byHolding;
}

// ── trailing passive income ──────────────────────────────────────────────────

export interface PassiveIncomeWindow {
  totalMinor: number;
  count: number;
  windowStartISO: string;
  windowEndISO: string;
}

/**
 * Sum of every payout in the trailing `months` window ending at today. The lower
 * bound is exclusive and the upper bound (today) inclusive, so a rent recorded
 * exactly twelve months ago is not double-counted at both ends of a rolling read.
 */
export function passiveIncomeTrailing(
  rows: ReadonlyArray<{ dateISO: string; amountMinor: number }>,
  todayISO: string,
  months = 12,
): PassiveIncomeWindow {
  const today = parse(todayISO);
  const start = addMonths(today, -months);
  const inWindow = rows.filter((r) => {
    const t = parse(r.dateISO).getTime();
    return t > start.getTime() && t <= today.getTime();
  });
  return {
    totalMinor: inWindow.reduce((acc, r) => acc + r.amountMinor, 0),
    count: inWindow.length,
    windowStartISO: toISO(start),
    windowEndISO: todayISO,
  };
}
