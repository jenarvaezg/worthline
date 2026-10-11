/**
 * The env-bound entry points of the trial emails (#1173): the welcome at
 * provisioning, and the pass the capture cron runs. Everything decided lives in
 * the pure modules beside this one; here only the coordinates are resolved —
 * settings from the environment, the control plane, the real sender.
 *
 * Both entry points degrade the same way and never throw:
 *  - no Resend key, no explicit verified sender or no signing secret → skipped
 *    with one log line naming what to set (and the control plane is not even
 *    opened, so no mark is consumed while mail is off);
 *  - no control plane (local no-auth) → skipped: there is no trial to talk about;
 *  - a control-plane or provider failure → logged, and the next pass retries.
 */

import {
  type ControlPlaneEnv,
  withOptionalControlPlaneStore,
} from "@web/control-plane-store";
import { sendEmail } from "@web/email/send-email";
import { errorMessage } from "@web/error-message";
import { SITE_URL } from "@web/site-url";
import type { StartedTrial } from "@worthline/db";
import { after } from "next/server";

import {
  deliverTrialEmail,
  type TrialEmailDeliveryDeps,
  type TrialEmailOutcome,
} from "./deliver-trial-email";
import { trialEmailSettingsFromEnv } from "./trial-email-settings";
import {
  runTrialEmailSweep,
  type TrialEmailSweepControlPlane,
  type TrialEmailSweepSummary,
} from "./trial-email-sweep";

export interface TrialEmailWiringOptions {
  env?: ControlPlaneEnv;
  siteUrl?: string;
  /** The reference instant; the wall clock by default. */
  now?: string;
  fetch?: typeof fetch;
  log?: Pick<Console, "error" | "info" | "warn">;
}

type Skipped =
  | { status: "skipped"; reason: "email_not_configured"; missing: string[] }
  | { status: "skipped"; reason: "no_control_plane" };

export type TrialEmailPassResult =
  | Skipped
  | { status: "ran"; summary: TrialEmailSweepSummary }
  | { status: "failed"; error: string };

export type WelcomeEmailResult = Skipped | { status: TrialEmailOutcome };

type WiredDeps = Omit<TrialEmailDeliveryDeps, "ledger"> & {
  controlPlane: TrialEmailSweepControlPlane;
};

/** Resolve settings + control plane and hand `run` the delivery deps, or say why not. */
async function withTrialEmails<T>(
  purpose: string,
  options: TrialEmailWiringOptions,
  run: (deps: WiredDeps) => Promise<T>,
): Promise<T | Skipped> {
  const env = options.env ?? process.env;
  const log = options.log ?? console;
  const resolution = trialEmailSettingsFromEnv(env, options.siteUrl ?? SITE_URL);
  if (resolution.status === "not_configured") {
    log.info(
      `[trial-email] ${purpose} skipped: set ${resolution.missing.join(", ")} to send the trial emails`,
    );
    return {
      missing: resolution.missing,
      reason: "email_not_configured",
      status: "skipped",
    };
  }
  const { settings } = resolution;
  const ran = await withOptionalControlPlaneStore<
    { value: T },
    TrialEmailSweepControlPlane
  >(
    async (controlPlane) => ({
      value: await run({
        controlPlane,
        log,
        now: options.now ?? new Date().toISOString(),
        send: (message) =>
          sendEmail(message, {
            config: settings.email,
            ...(options.fetch ? { fetch: options.fetch } : {}),
          }),
        settings,
      }),
    }),
    { env },
  );
  return ran ? ran.value : { reason: "no_control_plane", status: "skipped" };
}

/**
 * The cron's pass over every trial in flight. Never throws. `budgetMs` comes
 * from the caller's own deadline — `trialEmailSweepBudgetMs(maxDuration)`.
 */
export async function runTrialEmailPass(
  options: TrialEmailWiringOptions & { budgetMs: number },
): Promise<TrialEmailPassResult> {
  const { budgetMs, ...wiring } = options;
  try {
    const result = await withTrialEmails("pass", wiring, (deps) =>
      runTrialEmailSweep({ ...deps, budgetMs }),
    );
    return "status" in result ? result : { status: "ran", summary: result };
  } catch (error) {
    (wiring.log ?? console).error("[trial-email] pass failed", {
      error: errorMessage(error),
    });
    return { error: errorMessage(error), status: "failed" };
  }
}

/** The welcome for a trial that just started. Never throws. */
export async function sendWelcomeEmail(
  trial: StartedTrial,
  options: TrialEmailWiringOptions = {},
): Promise<WelcomeEmailResult> {
  try {
    return await withTrialEmails("welcome", options, async (deps) => ({
      status: await deliverTrialEmail("welcome", trial, {
        ...deps,
        ledger: deps.controlPlane,
      }),
    }));
  } catch (error) {
    (options.log ?? console).error("[trial-email] welcome failed", {
      error: errorMessage(error),
      userId: trial.userId,
    });
    return { status: "failed" };
  }
}

/**
 * Send the welcome AFTER the sign-in response, so a slow provider never holds
 * the login. When it cannot be deferred (no request scope: a script, a unit
 * test) nothing is sent now — the reason is logged, and the cron's pass retries
 * the welcome during the trial's first day.
 */
export function scheduleWelcomeEmail(
  trial: StartedTrial,
  options: TrialEmailWiringOptions & {
    defer?: (task: () => Promise<unknown>) => void;
  } = {},
): void {
  const { defer = after, ...wiring } = options;
  try {
    defer(() => sendWelcomeEmail(trial, wiring));
  } catch (error) {
    (wiring.log ?? console).warn(
      "[trial-email] could not defer the welcome; the next cron pass retries it",
      { error: errorMessage(error), userId: trial.userId },
    );
  }
}
