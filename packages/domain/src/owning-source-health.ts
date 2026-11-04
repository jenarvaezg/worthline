/**
 * The health of a connection that OWNS its holdings (#1885, PRD #1876 S10; ADR 0114
 * decisions 8 and 9): MyInvestor today. What its attempt log and its sync state say
 * the user should know, as kinds and dates — the words are each surface's.
 *
 * One reading, three readers: the band of avisos of a linked holding's ficha, the
 * MyInvestor row of Conexiones and the data-health collection (#654). Defined once
 * so the three cannot disagree about whether the connector is failing.
 *
 * - **«El conector falla»**, per kind of data (positions, orders, plans), only after
 *   {@link OWNING_SOURCE_FAILING_DAYS} calendar days in a row failing on it; a day
 *   with no attempt breaks the row. A pass reads the
 *   positions, then the orders, then the plans: a pass that failed on the plans did
 *   read the other two, so it is a good day for them. A pass that never reached a
 *   kind (the login failed, the database did) says nothing about it — neither a
 *   failure nor a reset.
 * - **The reminder**: with no saved password the connection only syncs when the
 *   user presses, so after {@link OWNING_SOURCE_UNSYNCED_REMINDER_DAYS} days without
 *   a good sync it asks, softly. With the password saved the daily sync runs and its
 *   failures speak for themselves.
 * - **The stop** of the periodic sync (#1884): the SMS to verify again, or the saved
 *   password MyInvestor rejected and worthline deleted.
 *
 * Calendar days are the app's (UTC), as the logins of a day are counted (#1884).
 */

import { daysBetween } from "./dates";

/** Days in a row a kind of data must fail before «El conector falla» says so. */
export const OWNING_SOURCE_FAILING_DAYS = 3;

/** Days without a good sync, with no saved password, before the reminder. */
export const OWNING_SOURCE_UNSYNCED_REMINDER_DAYS = 45;

/** The kinds of data a pass reads, in the order it reads them. */
export const OWNING_SOURCE_DATA_KINDS = ["positions", "orders", "plans"] as const;

export type OwningSourceDataKind = (typeof OWNING_SOURCE_DATA_KINDS)[number];

/**
 * The kind of data a step of the client reads (`MyInvestorStep`), or null for the
 * steps that read none (the login, the token refresh, the SMS). The cash is read
 * with the positions; the scheduled contributions with the plans.
 */
export function owningSourceDataKind(
  step: string | null | undefined,
): OwningSourceDataKind | null {
  switch (step) {
    case "cash":
    case "positions":
      return "positions";
    case "orders":
      return "orders";
    case "plans":
    case "contributions":
      return "plans";
    default:
      return null;
  }
}

/** One attempt of the log, newest first, as the rules read it. */
export interface OwningSourceAttempt {
  /** `pending`/`running` are in flight: they say nothing yet. */
  status: "pending" | "running" | "ok" | "error";
  /** The instant of the attempt, or null when the row dated none. */
  at: string | null;
  /** The client's step a failed attempt failed on; null when none was named. */
  failedStep?: string | null;
}

/** Why the periodic sync is stopped until the user acts. */
export type OwningSourceStop = "password_forgotten" | "sms_required";

/**
 * Whether the periodic sync is stopped, from the connection's sync state: the SMS
 * stop holds until a pass works again; the rejected saved password, until another
 * one is saved. A typed password MyInvestor rejected deletes nothing and stops
 * nothing.
 */
export function owningSourceStop(input: {
  stoppedReason: string | null;
  savedPassword: boolean;
  /** The last pass's outcome: its kind, and whether it forgot the saved password. */
  lastOutcome: { kind: string; forgotten: boolean | null } | null;
}): OwningSourceStop | null {
  if (input.stoppedReason === "sms_required") return "sms_required";
  const outcome = input.lastOutcome;
  if (
    !input.savedPassword &&
    outcome?.kind === "password_rejected" &&
    outcome.forgotten
  ) {
    return "password_forgotten";
  }
  return null;
}

export interface OwningSourceHealthFacts {
  /** The attempt log, NEWEST FIRST. */
  attempts: readonly OwningSourceAttempt[];
  savedPassword: boolean;
  /** The last good sync (`connected_sources.last_sync_at`). */
  lastSyncAt: string | null;
  stop: OwningSourceStop | null;
}

export type OwningSourceHealthNotice =
  | { kind: "stop"; stop: OwningSourceStop }
  | {
      kind: "failing";
      data: OwningSourceDataKind;
      /** Days from the first failing day to today, both counted. */
      days: number;
      /** The first day of the streak. */
      since: string;
    }
  | { kind: "unsynced"; days: number };

/** What the connection's health says on `asOfDateKey`, stop first. */
export function owningSourceHealth(
  facts: OwningSourceHealthFacts,
  asOfDateKey: string,
): OwningSourceHealthNotice[] {
  const notices: OwningSourceHealthNotice[] = [];
  if (facts.stop) notices.push({ kind: "stop", stop: facts.stop });

  for (const data of OWNING_SOURCE_DATA_KINDS) {
    const streak = failingStreak(facts.attempts, data);
    if (
      streak !== null &&
      daysBetween(streak.first, streak.last) + 1 >= OWNING_SOURCE_FAILING_DAYS
    ) {
      notices.push({
        data,
        days: daysBetween(streak.first, asOfDateKey) + 1,
        kind: "failing",
        since: streak.first,
      });
    }
  }

  const unsynced = unsyncedDays(facts, asOfDateKey);
  if (unsynced !== null) notices.push({ days: unsynced, kind: "unsynced" });
  return notices;
}

const ORDER: Record<OwningSourceDataKind, number> = { orders: 1, plans: 2, positions: 0 };

/**
 * The first and last day of the newest unbroken run of calendar days failing on
 * `data`, or null. The first attempt that read it (a good pass, or one that failed
 * on a later kind) ends the run. A day with no attempt at all breaks it too (#1885:
 * day 1 and day 3 failing are not three days in a row). A day whose only attempts
 * never reached `data` (the login failed) keeps the days around it in a row, but is
 * not a failing day of its own.
 */
function failingStreak(
  attempts: readonly OwningSourceAttempt[],
  data: OwningSourceDataKind,
): { first: string; last: string } | null {
  const attemptedDays = new Set<string>();
  const failingDays = new Set<string>();
  for (const attempt of attempts) {
    if (attempt.status === "pending" || attempt.status === "running") continue;
    if (attempt.status === "ok") break;
    if (attempt.at === null) continue;
    const failedOn = owningSourceDataKind(attempt.failedStep);
    if (failedOn !== null && ORDER[failedOn] > ORDER[data]) break;
    const day = attempt.at.slice(0, 10);
    attemptedDays.add(day);
    if (failedOn === data) failingDays.add(day);
  }

  // Newest first; the run walks back one calendar day at a time from the newest
  // failing day and stops at the first day nobody tried.
  const days = [...attemptedDays].sort().reverse();
  const start = days.findIndex((day) => failingDays.has(day));
  if (start === -1) return null;
  const last = days[start]!;
  let first = last;
  for (let index = start + 1; index < days.length; index += 1) {
    const day = days[index]!;
    if (daysBetween(day, days[index - 1]!) !== 1) break;
    if (failingDays.has(day)) first = day;
  }
  return { first, last };
}

function unsyncedDays(
  facts: OwningSourceHealthFacts,
  asOfDateKey: string,
): number | null {
  if (facts.savedPassword || facts.stop !== null || facts.lastSyncAt === null)
    return null;
  const days = daysBetween(facts.lastSyncAt.slice(0, 10), asOfDateKey);
  return days >= OWNING_SOURCE_UNSYNCED_REMINDER_DAYS ? days : null;
}
