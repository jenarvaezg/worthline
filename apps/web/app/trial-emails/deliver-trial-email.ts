/**
 * Send one email of the trial cycle (#1173) to one identity, at most once.
 *
 * The order is the guarantee:
 *
 *   1. **claim** the (identity, kind) mark in the control plane — losing it
 *      means another pass, or an earlier one, already has it: nothing to do;
 *   2. **send**, with a Resend idempotency key per (identity, kind), so a retry
 *      within Resend's 24 h window can never mail twice either;
 *   3. **confirm** when the provider accepted it, or **release** the claim when
 *      it did not, so a later pass retries.
 *
 * What it trades: a process that dies between 1 and 3 leaves a claim nobody
 * releases, and that email is never sent. «No reenviar nunca» wins over «enviar
 * siempre» — a missing reminder costs nothing, a duplicated one is the pressure
 * this feature promised not to apply.
 *
 * Never throws: the welcome rides a login and the sweep rides the capture cron,
 * and neither may fall over a mail outage. The address never reaches the logs —
 * the identity id is enough to find the row.
 */

import type { EmailMessage, SendEmailResult } from "@web/email/send-email";
import type { TrialEmailKind, TrialEmailLedger } from "@worthline/db";

import { reminderOptOutUrl } from "./reminder-opt-out-token";
import { buildTrialEmail } from "./trial-email-messages";
import type { TrialEmailSettings } from "./trial-email-settings";

export interface TrialEmailDeliveryDeps {
  ledger: Pick<
    TrialEmailLedger,
    "claimTrialEmail" | "confirmTrialEmail" | "releaseTrialEmail"
  >;
  /** Sends through the configured sender — `settings.email` already bound. */
  send(message: EmailMessage): Promise<SendEmailResult>;
  settings: TrialEmailSettings;
  now: string;
  log: Pick<Console, "error" | "info" | "warn">;
}

export interface TrialEmailRecipient {
  userId: string;
  email: string;
  trialEndsAt: string;
}

export type TrialEmailOutcome = "sent" | "already_claimed" | "failed";

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function deliverTrialEmail(
  kind: TrialEmailKind,
  recipient: TrialEmailRecipient,
  deps: TrialEmailDeliveryDeps,
): Promise<TrialEmailOutcome> {
  const claim = { kind, userId: recipient.userId };

  try {
    if (!(await deps.ledger.claimTrialEmail({ ...claim, at: deps.now }))) {
      return "already_claimed";
    }
  } catch (error) {
    deps.log.error("[trial-email] could not claim the mark; not sent", {
      ...claim,
      error: describe(error),
    });
    return "failed";
  }

  const { settings } = deps;
  const result = await deps.send({
    ...buildTrialEmail(kind, {
      optOutUrl: reminderOptOutUrl(
        settings.siteUrl,
        recipient.userId,
        settings.optOutSecret,
      ),
      replyTo: settings.replyTo,
      siteUrl: settings.siteUrl,
      to: recipient.email,
      trialEndsAt: recipient.trialEndsAt,
    }),
    idempotencyKey: `trial-${kind}-${recipient.userId}`,
  });

  if (result.status === "sent") {
    try {
      await deps.ledger.confirmTrialEmail({
        ...claim,
        at: deps.now,
        providerMessageId: result.id,
      });
    } catch (error) {
      // The claim row stays, so it is still never sent again — only the
      // confirmation stamp is missing.
      deps.log.warn("[trial-email] sent, but the confirmation was not recorded", {
        ...claim,
        error: describe(error),
      });
    }
    return "sent";
  }

  deps.log.error("[trial-email] send failed; the claim is released for a retry", {
    ...claim,
    error: result.status === "failed" ? result.error : result.reason,
    httpStatus: result.status === "failed" ? result.httpStatus : null,
  });
  try {
    await deps.ledger.releaseTrialEmail(claim);
  } catch (error) {
    deps.log.error(
      "[trial-email] could not release the claim; this email will not be retried",
      {
        ...claim,
        error: describe(error),
      },
    );
  }
  return "failed";
}
