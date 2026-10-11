import type { EmailConfig, EmailEnv } from "@web/email/send-email";
import { LEGAL_IDENTITY_ENV } from "@web/legal/legal-identity";

/**
 * What the trial emails (#1173) need from the environment, and whether they
 * have it. Stricter than the feedback mail on purpose:
 *
 *  - the sender must be EXPLICIT (`WORTHLINE_EMAIL_FROM`) and not Resend's
 *    `resend.dev` sandbox, which delivers only to the account owner — fine for a
 *    maintainer notification, a 403 for every real user. Without it the emails
 *    are skipped with a log line instead of failing against real people;
 *  - the opt-out link is signed with `AUTH_SECRET`; with no way to offer an
 *    honest «no recibir recordatorios», nothing is sent at all.
 *
 * Replies go to the published contact address (`WORTHLINE_LEGAL_CONTACT_EMAIL`)
 * when there is one, so a person who answers a trial email reaches somebody.
 */

export interface TrialEmailSettings {
  email: EmailConfig;
  /** The key of the opt-out link's signature. */
  optOutSecret: string;
  /** Absolute origin for the links, without a trailing slash. */
  siteUrl: string;
  replyTo: string | null;
}

export type TrialEmailSettingsResolution =
  | { status: "ready"; settings: TrialEmailSettings }
  | { status: "not_configured"; missing: string[] };

const SANDBOX_DOMAIN = /@resend\.dev>?\s*$/i;

function read(env: EmailEnv, name: string): string | null {
  const value = env[name]?.trim();
  return value ? value : null;
}

export function trialEmailSettingsFromEnv(
  env: EmailEnv,
  siteUrl: string,
): TrialEmailSettingsResolution {
  const apiKey = read(env, "RESEND_API_KEY");
  const declaredFrom = read(env, "WORTHLINE_EMAIL_FROM");
  const from = declaredFrom && !SANDBOX_DOMAIN.test(declaredFrom) ? declaredFrom : null;
  const optOutSecret = read(env, "AUTH_SECRET");

  if (!apiKey || !from || !optOutSecret) {
    return {
      missing: [
        ...(apiKey ? [] : ["RESEND_API_KEY"]),
        ...(from ? [] : ["WORTHLINE_EMAIL_FROM"]),
        ...(optOutSecret ? [] : ["AUTH_SECRET"]),
      ],
      status: "not_configured",
    };
  }
  return {
    settings: {
      email: { apiKey, from },
      optOutSecret,
      replyTo: read(env, LEGAL_IDENTITY_ENV.contactEmail),
      siteUrl,
    },
    status: "ready",
  };
}
