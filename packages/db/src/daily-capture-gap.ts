/**
 * Missed-pass detection for the daily-capture cron (#1339).
 *
 * Vercel Cron is best-effort on the current plan: invocations arrive late (up to
 * an hour) and sometimes never arrive at all — the evidence on #1339 shows whole
 * passes that were never even enqueued. Latest-wins (ADR 0005) keeps the damage
 * mild (a lost `:pm` leaves the day closing on the provisional 09:00 point), but
 * today the loss is INVISIBLE. This module turns the silence into a signal: given
 * the pass about to run and the last one that was INVOKED, it names every pass in
 * between.
 *
 * "Invoked" — not "finalized" — is the deliberate baseline. Every invocation
 * enqueues its pass onto the durable queue before anything else, so a pass with no
 * job row was never invoked; a pass that ran and failed has a row and its own
 * failure trail. Measuring against finalization instead would turn one chronically
 * broken tenant (which blocks finalization forever) into a daily stream of alerts
 * blaming a scheduler that did its job.
 *
 * Pure arithmetic over run keys — no clock, no store, no I/O. Run keys are the
 * pass-qualified `YYYY-MM-DD:am|pm` that `dailyCaptureRunKey` mints (#895).
 */

/** How many missed passes one detection reports at most — four days of passes. */
export const MISSED_PASS_REPORT_LIMIT = 8;

/** A parsed daily-capture run key (#1339). */
export interface DailyCapturePass {
  /** The UTC day the pass belongs to (`YYYY-MM-DD`). */
  dateKey: string;
  /** Which of the day's two passes: the ≈09:00 provisional or the ≈21:00 close. */
  pass: "am" | "pm";
  /**
   * Position on the global am/pm timeline: two slots per UTC day, `am` before
   * `pm`. Comparing ordinals — never strings — is what makes month, year, and
   * leap-day boundaries free.
   */
  ordinal: number;
}

export interface MissedDailyCapturePasses {
  /** The missed run keys, oldest first; capped at the limit, keeping the FRESHEST. */
  missed: string[];
  /** How many older missed passes the cap left out — never a silent truncation. */
  omitted: number;
}

const MS_PER_DAY = 86_400_000;
const RUN_KEY_PATTERN = /^(\d{4})-(\d{2})-(\d{2}):(am|pm)$/;

const NOTHING_MISSED: MissedDailyCapturePasses = { missed: [], omitted: 0 };

/**
 * Parse a pass-qualified run key, or null when the string is not one. Strict on
 * purpose: the calendar is validated by round-tripping the day (so `2026-13-45`,
 * which `Date.UTC` would happily roll over into 2027, is rejected), and a key with
 * no `:am`/`:pm` suffix is not a pass. Callers must degrade rather than guess —
 * every string here comes from a database row, not from a fresh mint.
 */
export function parseDailyCapturePass(runKey: string): DailyCapturePass | null {
  const match = RUN_KEY_PATTERN.exec(runKey);
  if (!match) return null;
  const [, year, month, day, pass] = match;
  const dayMs = Date.UTC(Number(year), Number(month) - 1, Number(day));
  const dateKey = `${year}-${month}-${day}`;
  if (new Date(dayMs).toISOString().slice(0, 10) !== dateKey) return null;
  return {
    dateKey,
    pass: pass === "am" ? "am" : "pm",
    ordinal: Math.floor(dayMs / MS_PER_DAY) * 2 + (pass === "am" ? 0 : 1),
  };
}

/** The run key of a pass ordinal — the inverse of {@link parseDailyCapturePass}. */
function passKeyFromOrdinal(ordinal: number): string {
  const dayKey = new Date(Math.floor(ordinal / 2) * MS_PER_DAY)
    .toISOString()
    .slice(0, 10);
  return `${dayKey}:${ordinal % 2 === 0 ? "am" : "pm"}`;
}

/**
 * Every expected pass strictly between the last invoked one and the pass now
 * running — i.e. the ones the scheduler skipped.
 *
 * Silent by construction in the cases that are NOT a gap:
 *   - no baseline (`latestInvokedRunKey: null`) — a fresh deploy has no history,
 *     so nothing was missed;
 *   - a baseline at or ahead of this pass (a redelivered job, a replay, clock
 *     skew) — never invent a gap;
 *   - an unparseable key on either side — report nothing rather than throw.
 */
export function missedDailyCapturePasses({
  currentRunKey,
  latestInvokedRunKey,
}: {
  currentRunKey: string;
  latestInvokedRunKey: string | null;
}): MissedDailyCapturePasses {
  if (latestInvokedRunKey === null) return NOTHING_MISSED;
  const current = parseDailyCapturePass(currentRunKey);
  const latest = parseDailyCapturePass(latestInvokedRunKey);
  if (!current || !latest) return NOTHING_MISSED;

  const total = current.ordinal - latest.ordinal - 1;
  if (total < 1) return NOTHING_MISSED;

  const reported = Math.min(total, MISSED_PASS_REPORT_LIMIT);
  const missed: string[] = [];
  for (
    let ordinal = current.ordinal - reported;
    ordinal < current.ordinal;
    ordinal += 1
  ) {
    missed.push(passKeyFromOrdinal(ordinal));
  }
  return { missed, omitted: total - reported };
}
