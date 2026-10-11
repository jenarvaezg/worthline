/**
 * «No recibir recordatorios» (#1173): what pressing the button on the email
 * link's page does, as a function of the token and its two seams.
 *
 * Only the identity the signed token names is touched — there is no session
 * on that page, and none is needed. A write that did not land comes back as an
 * error, never as «hecho»: telling someone they will not be emailed when the
 * preference was not saved is exactly the dishonesty the feature exists to avoid.
 */

import { verifyReminderOptOutToken } from "./reminder-opt-out-token";

export type DeclineRemindersState =
  | { status: "idle" }
  | { status: "done" }
  | { status: "error"; error: string };

export const DECLINE_IDLE: DeclineRemindersState = { status: "idle" };

export const DECLINE_INVALID_LINK =
  "Este enlace no es válido o está incompleto. Vuelve a abrirlo desde el correo.";

/** The read-only demo or an admin impersonating a workspace (#1180) writes nothing. */
export const DECLINE_READ_ONLY_SESSION =
  "Desde esta sesión de solo lectura no se puede guardar. Abre el enlace en una ventana sin la demo ni la vista de administración.";

export const DECLINE_UNAVAILABLE =
  "No se ha podido guardar ahora mismo. Vuelve a intentarlo en un rato.";

export interface DeclineRemindersDeps {
  /** The opt-out link's signing secret, or null when the deployment has none. */
  secret: string | null;
  /** Persist the opt-out; resolves false when there is nowhere to persist it. */
  record(userId: string, at: string): Promise<boolean>;
  now: string;
  log: Pick<Console, "error">;
}

export async function declineTrialReminders(
  token: string | null | undefined,
  deps: DeclineRemindersDeps,
): Promise<DeclineRemindersState> {
  const userId = deps.secret ? verifyReminderOptOutToken(token, deps.secret) : null;
  if (!userId) return { error: DECLINE_INVALID_LINK, status: "error" };

  try {
    return (await deps.record(userId, deps.now))
      ? { status: "done" }
      : { error: DECLINE_UNAVAILABLE, status: "error" };
  } catch (error) {
    deps.log.error("[trial-email] could not record the reminder opt-out", {
      error: error instanceof Error ? error.message : String(error),
      userId,
    });
    return { error: DECLINE_UNAVAILABLE, status: "error" };
  }
}
