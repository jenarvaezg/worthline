"use server";

import { raiseMaintainerAlert } from "@web/asistente/maintainer-alert-store";
import { isWriteBlocked } from "@web/demo/write-guard";
import { sendEmail } from "@web/email/send-email";
import { readSessionEmail, readStoreTarget } from "@web/read-store-target";
import { SITE_URL } from "@web/site-url";
import { normalizeAdminEmail } from "@web/store-resolver";

import { deliverFeedback } from "./deliver-feedback";
import {
  type FeedbackFormState,
  parseFeedbackMessage,
  parseFeedbackPage,
} from "./feedback-message";

/**
 * «Enviar feedback» (#1174): the in-app button's server action.
 *
 * The outcome returns as STATE, success included. A redirect would remount the
 * form and drop the draft — and a rejection carried by a navigation can be lost
 * outright (interaction-patterns §4.1). There is nothing on the page to revalidate
 * either: the message goes to the control plane and to the maintainer's inbox,
 * never into the workspace.
 *
 * Only a signed-in user's OWN session sends. The read-only demo has no one to
 * answer and is public, and an admin impersonating a workspace must not write in
 * that user's name — `isWriteBlocked` refuses both, before anything is read.
 */
export async function submitFeedbackAction(
  _previous: FeedbackFormState,
  formData: FormData,
): Promise<FeedbackFormState> {
  if (await isWriteBlocked()) {
    return {
      error: "Desde aquí no se puede enviar feedback: es una sesión de solo lectura.",
      status: "error",
    };
  }

  const target = await readStoreTarget();
  if (target.kind !== "authenticated") {
    return {
      error: "Para enviar feedback necesitas haber iniciado sesión.",
      status: "error",
    };
  }

  const parsed = parseFeedbackMessage(formData.get("message"));
  if (!parsed.ok) return { error: parsed.error, status: "error" };

  const delivery = await deliverFeedback(
    {
      email: await readSessionEmail(),
      feedbackId: crypto.randomUUID(),
      message: parsed.message,
      page: parseFeedbackPage(formData.get("page")),
      submittedAt: new Date().toISOString(),
      workspaceId: target.workspaceId,
    },
    {
      log: console,
      // The maintainer IS the admin: the one address that can open the /admin
      // alert the mail links to.
      maintainerEmail: normalizeAdminEmail(process.env.WORTHLINE_ADMIN_EMAIL),
      raiseAlert: raiseMaintainerAlert,
      sendEmail: (message) => sendEmail(message),
      siteUrl: SITE_URL,
    },
  );

  return delivery.delivered
    ? { status: "sent" }
    : {
        error:
          "No se ha podido enviar ahora mismo. Tu mensaje sigue aquí: vuelve a intentarlo en un rato.",
        status: "error",
      };
}
