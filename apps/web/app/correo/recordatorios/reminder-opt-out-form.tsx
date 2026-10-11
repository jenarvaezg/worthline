"use client";

import { DECLINE_IDLE } from "@web/trial-emails/decline-trial-reminders";
import { REMINDER_OPT_OUT_PARAM } from "@web/trial-emails/reminder-opt-out-token";
import { useActionState, useEffect, useRef } from "react";

import { declineTrialRemindersAction } from "./actions";

/**
 * The one button of the «no recibir recordatorios» page (#1173). A thin shell
 * (interaction-patterns §7): the decision lives in `decline-trial-reminders.ts`.
 * Not optimistic on purpose — the documented exception in interaction-patterns
 * §4: «hecho» is said only once the preference is stored, because a faked
 * confirmation here would be a broken promise in the person's inbox. The
 * outcome comes back as state (§4.1, same exception as the feedback). Focus
 * moves to the confirmation once the button is gone (§8).
 */
export default function ReminderOptOutForm({ token }: { token: string }) {
  const [state, action, pending] = useActionState(
    declineTrialRemindersAction,
    DECLINE_IDLE,
  );
  const doneRef = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    if (state.status === "done") doneRef.current?.focus();
  }, [state]);

  if (state.status === "done") {
    return (
      <p className="successBand" ref={doneRef} role="status" tabIndex={-1}>
        Hecho. No te escribiremos más sobre la prueba: ni el aviso antes de que termine ni
        el de cuando termine.
      </p>
    );
  }

  return (
    <form action={action} className="stackForm">
      <input name={REMINDER_OPT_OUT_PARAM} type="hidden" value={token} />
      <p
        aria-live="polite"
        className={state.status === "error" ? "formError" : undefined}
      >
        {state.status === "error" ? state.error : ""}
      </p>
      <button aria-busy={pending || undefined} disabled={pending} type="submit">
        {pending ? "Guardando…" : "No quiero recibir estos avisos"}
      </button>
    </form>
  );
}
