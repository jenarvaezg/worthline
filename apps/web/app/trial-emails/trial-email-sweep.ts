/**
 * One pass over every trial in flight (#1173): mail each identity the email its
 * trial owes right now — the day-2 reminder, the expiry notice, or a welcome
 * whose send failed at provisioning — and nothing else.
 *
 * It rides the twice-daily capture cron (`/api/cron/snapshot`) instead of a cron
 * of its own: the hosted plan is Vercel Hobby, and two passes a day are plenty
 * for windows a day wide. Being idempotent is the ledger's job (claim before
 * send, see `deliver-trial-email.ts`), so a pass can run any number of times.
 *
 * Two limits, both about the provider and the function, never about the user:
 *  - the sends are **spaced** under Resend's default rate limit (2 req/s);
 *  - the pass stops **starting** sends once its time budget is spent, well
 *    inside the cron's `maxDuration`, so a slow provider never gets a send cut
 *    in half (which would leave a claim nobody releases). What is left over is
 *    still unclaimed, and the next pass picks it up.
 */

import type { TrialEmailLedger } from "@worthline/db";

import { deliverTrialEmail, type TrialEmailDeliveryDeps } from "./deliver-trial-email";
import { dueTrialEmail, TRIAL_EMAIL_CUTOFF_MS } from "./trial-email-schedule";

/** Resend's default limit is 2 requests per second; stay under it. */
const SEND_SPACING_MS = 600;

/** Stop starting sends after this long — the cron route's `maxDuration` is 60 s. */
const SWEEP_BUDGET_MS = 40_000;

export interface TrialEmailSweepDeps extends TrialEmailDeliveryDeps {
  ledger: TrialEmailLedger;
  /** Wait between two sends. Injectable so tests do not sleep. */
  pause?: (ms: number) => Promise<void>;
  /** Monotonic-enough milliseconds for the time budget. */
  clock?: () => number;
}

export interface TrialEmailSweepSummary {
  /** Identities with a trial in any window (or recently closed). */
  candidates: number;
  /** How many of them owed an email this pass. */
  due: number;
  sent: number;
  failed: number;
  /** Lost the claim to an overlapping pass. */
  alreadyClaimed: number;
  /** Left for the next pass because the time budget ran out. */
  deferred: number;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function runTrialEmailSweep(
  deps: TrialEmailSweepDeps,
): Promise<TrialEmailSweepSummary> {
  const { pause = sleep, clock = Date.now } = deps;
  const startedAt = clock();
  const candidates = await deps.ledger.listTrialEmailCandidates({
    trialEndsAfter: new Date(Date.parse(deps.now) - TRIAL_EMAIL_CUTOFF_MS).toISOString(),
  });

  const summary: TrialEmailSweepSummary = {
    alreadyClaimed: 0,
    candidates: candidates.length,
    deferred: 0,
    due: 0,
    failed: 0,
    sent: 0,
  };

  let attempted = 0;
  for (const candidate of candidates) {
    const kind = dueTrialEmail(candidate, deps.now);
    if (!kind) continue;
    summary.due += 1;

    if (clock() - startedAt >= SWEEP_BUDGET_MS) {
      summary.deferred += 1;
      continue;
    }
    if (attempted > 0) await pause(SEND_SPACING_MS);
    attempted += 1;

    const outcome = await deliverTrialEmail(kind, candidate, deps);
    if (outcome === "sent") summary.sent += 1;
    else if (outcome === "failed") summary.failed += 1;
    else summary.alreadyClaimed += 1;
  }
  return summary;
}
