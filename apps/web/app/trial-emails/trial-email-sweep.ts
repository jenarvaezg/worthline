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
 *  - the pass stops **starting** sends once its time budget is spent, so a slow
 *    provider never gets a send cut in half by the platform (which would leave
 *    a claim nobody releases). What is left over is still unclaimed, and the
 *    next pass picks it up.
 */

import { SEND_TIMEOUT_MS } from "@web/email/send-email";

import { deliverTrialEmail, type TrialEmailDeliveryDeps } from "./deliver-trial-email";
import {
  listTrialEmailCandidates,
  type TrialEmailCandidatePorts,
} from "./trial-email-candidates";
import { dueTrialEmail, TRIAL_EMAIL_CUTOFF_MS } from "./trial-email-schedule";

/** Resend's default limit is 2 requests per second; stay under it. */
const SEND_SPACING_MS = 600;

/** Headroom for the control-plane round trips around the last send (claim, confirm). */
const CONTROL_PLANE_HEADROOM_MS = 5_000;

/**
 * How long a pass may keep STARTING sends inside a function that lives
 * `maxDurationSeconds`: the last one can still pause, wait out a slow provider
 * up to the send timeout, and write its mark before the platform kills it.
 * Derived here, from the numbers it depends on, so changing any of them moves
 * the budget with it.
 */
export function trialEmailSweepBudgetMs(maxDurationSeconds: number): number {
  return (
    maxDurationSeconds * 1000 -
    SEND_TIMEOUT_MS -
    SEND_SPACING_MS -
    CONTROL_PLANE_HEADROOM_MS
  );
}

/** What the pass reads (who is in a window) plus what each send writes (the marks). */
export type TrialEmailSweepControlPlane = TrialEmailCandidatePorts &
  TrialEmailDeliveryDeps["ledger"];

export interface TrialEmailSweepDeps extends Omit<TrialEmailDeliveryDeps, "ledger"> {
  controlPlane: TrialEmailSweepControlPlane;
  /** Stop starting sends after this many ms — see {@link trialEmailSweepBudgetMs}. */
  budgetMs: number;
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
  const candidates = await listTrialEmailCandidates(deps.controlPlane, {
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

    if (clock() - startedAt >= deps.budgetMs) {
      summary.deferred += 1;
      continue;
    }
    if (attempted > 0) await pause(SEND_SPACING_MS);
    attempted += 1;

    const outcome = await deliverTrialEmail(kind, candidate, {
      ...deps,
      ledger: deps.controlPlane,
    });
    if (outcome === "sent") summary.sent += 1;
    else if (outcome === "failed") summary.failed += 1;
    else summary.alreadyClaimed += 1;
  }
  return summary;
}
