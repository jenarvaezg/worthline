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

import { addMonthsToDate } from "./dates";

export type PayoutCadence = "weekly" | "monthly" | "quarterly" | "annual";

/**
 * What kind of lease this income comes from — and therefore **what `endISO`
 * means** (#1521).
 *
 * A season's let or a holiday let ends when its date says it ends: the flat really
 * does stop paying, and projecting nothing after it is the honest answer. A
 * long-term residential lease is the opposite case — the signed date is the end of
 * the *mandatory* term, and the contract may well continue by law past it, so
 * reading that date as "the rent disappears for ever" is an assumption nobody
 * declared.
 *
 * The regime declares the NATURE of the contract; worthline never derives how many
 * years of statutory extension are left from it. That is a legal engine with a
 * version and a territory, and it is deliberately out of scope: if the date on
 * which the decision comes back to the owner is not `endISO`, the owner declares it.
 */
export type LeaseRegime = "residential_long_term" | "seasonal" | "vacation" | "other";

/**
 * How the rent is revised over time (#1521). Not decorative: ADR 0076 point 4
 * substitutes a net rental yield for the housing rung's default **because rent is
 * inflation-linked**, i.e. a net rental yield already IS a real yield.
 *
 * - `legal_reference` (revised by a statutory index — the free label says which,
 *   e.g. IRAV) and `contractual` (revised by a clause in the contract) both keep
 *   that assumption.
 * - `fixed` (a nominal amount that never moves) and `none` break it: the declared
 *   yield would be read as real while it loses purchasing power every year, which
 *   overstates in the dangerous direction. The engine refuses to read those as real
 *   rather than inventing a decay rate for them.
 *
 * Absent / null is **not declared**, and assumes nothing: the engine keeps doing
 * exactly what it did before this field existed.
 */
export type RentRevision = "legal_reference" | "contractual" | "fixed" | "none";

/**
 * What the owner says happens once the period in which the decision is HIS again
 * begins — the end of the mandatory term, not the signed `endISO` (#1521). The name
 * carries half the fix: `projection_policy` would have re-attached the policy to a
 * date that, under a long-term residential regime, decides nothing.
 *
 * - `renew_same_real_rent`: the rent keeps running at the same REAL amount.
 * - `stop`: the asset goes back to its rung's default. What the app did for every
 *   ended lease before this field existed — honest for a season's let, an invention
 *   for a long-term residential one.
 * - `unknown`: declared as undecided. Falls back to what the regime implies, exactly
 *   like an absent value, and the difference is what the ficha SAYS, not what the
 *   engine computes.
 *
 * A real rent-growth rate (`renew_with_growth`) is deliberately not offered: that is
 * a forecast, and worthline does not make forecasts.
 */
export type PostMandatoryTermPolicy = "renew_same_real_rent" | "stop" | "unknown";

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
  /**
   * What this income costs its owner, per occurrence and in the SAME cadence as
   * `amountMinor` — the agency, the IBI, the insurance, the community fees, the
   * maintenance, the empty months (#1448). The one exception to "a payout is
   * income-only": it adds no net-worth figure either (net rent is not a payout).
   * Two consumers, two rules: the FIRE return uses it so a rented property yields
   * its NET rate instead of the housing rung's guessed 3 % (and refuses to derive
   * when it is missing), and the passive-income lens nets its window with it
   * (#1463) — subtracting where declared, gross elsewhere.
   *
   * Absent / null means **not declared**, and nothing is assumed from it: no rate
   * is derived at all rather than the gross being used, which would flatter. A
   * declared `0` is a different statement — "this income costs me nothing" — and
   * does derive.
   */
  expensesMinor?: number | null;
  cadence: PayoutCadence;
  startISO: string;
  /** A retroactive end date removes the dead tail in one edit. Inclusive. */
  endISO: string | null;
  /** ISO dates removed one by one (an unpaid month). */
  exclusions: string[];
  /**
   * The legal nature of the lease (#1521) — what `endISO` MEANS. Absent / null is
   * "not declared" and the engine keeps behaving as it always did (`stop`), saying
   * so on the ficha rather than hiding it. See {@link LeaseRegime}.
   */
  leaseRegime?: LeaseRegime | null;
  /**
   * How the rent is revised (#1521). Absent / null assumes nothing; `fixed` / `none`
   * are the two declarations that STOP the FIRE rate from reading the yield as real.
   * See {@link RentRevision}.
   */
  rentRevision?: RentRevision | null;
  /**
   * The free label naming the statutory index behind `rentRevision === "legal_reference"`
   * (e.g. "IRAV"). Documentary only — there is no legal engine behind it, and no figure
   * anywhere reads it. Null / absent on every other revision.
   */
  rentRevisionReference?: string | null;
  /**
   * What happens once the mandatory term is over (#1521). Absent / null and `unknown`
   * both fall back to what {@link leaseRegime} implies. See {@link PostMandatoryTermPolicy}.
   */
  postMandatoryTermPolicy?: PostMandatoryTermPolicy | null;
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
  return addMonthsToDate(start, CADENCE_STEP_MONTHS[cadence] * k);
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
  /**
   * The occurrence's declared cost (#1463), carried from its schedule's
   * `expensesMinor` — one-offs never have one. Absent means not declared, and the
   * occurrence nets as its gross: the lens' rule is "subtract where there is a
   * figure", unlike the FIRE rate (#1448) which refuses to derive at all. Returns
   * and the delta breakdown ignore this on purpose: a payout stays attribution
   * (ADR 0054), and what arrived is the gross.
   */
  expensesMinor?: number;
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
    // Today's expense declaration rides every occurrence, past ones included —
    // the same retroactivity the schedule's exclusions already have (#1463).
    for (const occurrence of deriveScheduleOccurrences(schedule, todayISO)) {
      push(occurrence.holdingId, {
        dateISO: occurrence.dateISO,
        amountMinor: occurrence.amountMinor,
        ...(schedule.expensesMinor == null
          ? {}
          : { expensesMinor: schedule.expensesMinor }),
      });
    }
  }
  return byHolding;
}

// ── trailing passive income ──────────────────────────────────────────────────

export interface PassiveIncomeWindow {
  /** Gross sum of the window's payouts — what arrived (attribution, ADR 0054). */
  totalMinor: number;
  /** Declared expenses of the window's occurrences; 0 where nothing is declared. */
  expensesMinor: number;
  /** totalMinor − expensesMinor: what the owner lives on (#1463). */
  netMinor: number;
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
  rows: ReadonlyArray<{ dateISO: string; amountMinor: number; expensesMinor?: number }>,
  todayISO: string,
  months = 12,
): PassiveIncomeWindow {
  const today = parse(todayISO);
  const start = addMonthsToDate(today, -months);
  const inWindow = rows.filter((r) => {
    const t = parse(r.dateISO).getTime();
    return t > start.getTime() && t <= today.getTime();
  });
  const totalMinor = inWindow.reduce((acc, r) => acc + r.amountMinor, 0);
  const expensesMinor = inWindow.reduce((acc, r) => acc + (r.expensesMinor ?? 0), 0);
  return {
    totalMinor,
    expensesMinor,
    netMinor: totalMinor - expensesMinor,
    count: inWindow.length,
    windowStartISO: toISO(start),
    windowEndISO: todayISO,
  };
}
