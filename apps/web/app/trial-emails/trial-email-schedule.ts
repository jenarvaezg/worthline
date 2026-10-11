/**
 * Which email of the trial cycle (#1173) is due for one identity, right now.
 *
 * Pure over the candidate and a clock, so every window is a unit test. The
 * windows never overlap, so a pass can owe at most one email per identity and
 * two of them never land together:
 *
 *   start ── +1 day ─────────────── end −12 h ── end ──── +2 days
 *   │ welcome │ trial_reminder (día 2) │ nothing │ trial_expired │ nothing
 *
 *  - **welcome**: sent at provisioning; the first day is only the window in
 *    which a pass may RETRY a send that failed there. Past it, the reminder is
 *    what the person hears next — a welcome a day late would just be noise.
 *  - **trial_reminder**: from day 2 until {@link REMINDER_CLOSES_BEFORE_END_MS}
 *    before the close. A retry that only lands on the last half-day would read
 *    «termina el X» on day X itself — urgency the feature promised not to apply
 *    — and the expiry notice already says the same, a few hours later.
 *  - **trial_expired**: from the close, for {@link TRIAL_EMAIL_CUTOFF_MS}. The
 *    cutoff is what keeps a first deploy or a long outage from announcing, as
 *    news, a trial that ended weeks ago.
 *
 * The start is read off the end (`trialEndsAt − TRIAL_DURATION_DAYS`), the same
 * arithmetic that set the end at provisioning (`trialEndsAtFrom`); only the
 * entitlement row carries the window.
 *
 * Both deferred emails speak only to a workspace that is still in the state
 * they describe: a workspace that went premium during the trial (checkout or
 * the admin palanca) hears nothing more about the trial, because «tu prueba
 * termina» and «has pasado a free» would both be false. «No recibir
 * recordatorios» silences both of them and never the welcome — by the time the
 * person can click it, the welcome is already in their inbox.
 */

import {
  deriveEffectivePlan,
  TRIAL_DURATION_DAYS,
  type TrialEmailKind,
} from "@worthline/db";

import type { TrialEmailCandidate } from "./trial-email-candidates";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** «Día 2»: the reminder opens one day into the trial, closing the welcome's retry window. */
const REMINDER_OPENS_AFTER_MS = DAY_MS;

/** The reminder stops being sent this long before the trial closes. */
const REMINDER_CLOSES_BEFORE_END_MS = 12 * HOUR_MS;

/** How long after the close the expiry notice is still news. */
export const TRIAL_EMAIL_CUTOFF_MS = 2 * DAY_MS;

export function dueTrialEmail(
  candidate: TrialEmailCandidate,
  now: string,
): TrialEmailKind | null {
  const at = Date.parse(now);
  const endsAt = Date.parse(candidate.trialEndsAt);
  const startedAt = endsAt - TRIAL_DURATION_DAYS * DAY_MS;
  const plan = deriveEffectivePlan(candidate, now);
  const claimed = new Set(candidate.claimedKinds);
  const optedOut = candidate.remindersOptedOutAt !== null;

  if (at < endsAt) {
    if (plan !== "trial") return null;
    if (at < startedAt + REMINDER_OPENS_AFTER_MS) {
      return claimed.has("welcome") ? null : "welcome";
    }
    if (at >= endsAt - REMINDER_CLOSES_BEFORE_END_MS) return null;
    return optedOut || claimed.has("trial_reminder") ? null : "trial_reminder";
  }

  if (at >= endsAt + TRIAL_EMAIL_CUTOFF_MS || plan !== "free") return null;
  return optedOut || claimed.has("trial_expired") ? null : "trial_expired";
}
