"use server";

import { withOptionalControlPlaneStore } from "@web/control-plane-store";
import { isWriteBlocked } from "@web/demo/write-guard";
import {
  DECLINE_READ_ONLY_SESSION,
  type DeclineRemindersState,
  declineTrialReminders,
} from "@web/trial-emails/decline-trial-reminders";
import {
  REMINDER_OPT_OUT_PARAM,
  reminderOptOutSecret,
} from "@web/trial-emails/reminder-opt-out-token";
import type { TrialEmailLedger } from "@worthline/db";

/**
 * «No quiero recibir estos avisos» (#1173): the button on the email link's page.
 *
 * No session needed: the person arrives from their inbox, possibly signed out,
 * and the only thing this can touch is the preference of the identity the signed
 * token names. The write guard still runs first (#1180): a read-only demo or an
 * admin impersonating a workspace writes nothing from here — that visitor is
 * told to open the link in a window without that session. The outcome returns
 * as state, success included (interaction-patterns §4.1): nothing to revalidate.
 */
export async function declineTrialRemindersAction(
  _previous: DeclineRemindersState,
  formData: FormData,
): Promise<DeclineRemindersState> {
  if (await isWriteBlocked()) {
    return { error: DECLINE_READ_ONLY_SESSION, status: "error" };
  }
  const token = formData.get(REMINDER_OPT_OUT_PARAM);
  return declineTrialReminders(typeof token === "string" ? token : null, {
    log: console,
    now: new Date().toISOString(),
    record: async (userId, at) =>
      (await withOptionalControlPlaneStore<true, TrialEmailLedger>(async (ledger) => {
        await ledger.optOutOfTrialReminders({ at, userId });
        return true as const;
      })) ?? false,
    secret: reminderOptOutSecret(),
  });
}
