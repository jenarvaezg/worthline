"use server";

import { raiseMaintainerAlert } from "@web/asistente/maintainer-alert-store";
import { comparableEmail } from "@web/comparable-email";
import { isWriteBlocked } from "@web/demo/write-guard";
import { sendEmail } from "@web/email/send-email";
import { readSessionEmail, readStoreTarget } from "@web/read-store-target";
import { SITE_URL } from "@web/site-url";

import { deliverFeedback } from "./deliver-feedback";
import { canSendFeedback } from "./feedback-eligibility";
import {
  type FeedbackFormState,
  parseFeedbackId,
  parseFeedbackMessage,
  parseFeedbackPage,
} from "./feedback-message";
import { admitFeedbackSend, FEEDBACK_RATE_LIMITED_MESSAGE } from "./feedback-rate-limit";

/**
 * «Enviar feedback» (#1174): the in-app button's server action.
 *
 * The outcome returns as STATE, success included. A redirect would remount the
 * form and drop the draft — and a rejection carried by a navigation can be lost
 * outright (interaction-patterns §4.1). There is nothing on the page to revalidate
 * either: the message goes to the control plane and to the maintainer's inbox,
 * never into the workspace.
 *
 * Only a signed-in user's OWN session sends (`canSendFeedback`, the same rule
 * every mount of the button reads). The read-only demo and an impersonating admin
 * are refused by `isWriteBlocked` before anything else is read.
 *
 * Order matters: the text is validated BEFORE the hourly allowance is counted, so
 * a refused draft does not spend it; the allowance is counted BEFORE anything is
 * written, so a send over the limit leaves no alert and no email behind.
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
  if (!canSendFeedback(target)) {
    return {
      error: "Para enviar feedback necesitas haber iniciado sesión.",
      status: "error",
    };
  }

  const parsed = parseFeedbackMessage(formData.get("message"));
  if (!parsed.ok) return { error: parsed.error, status: "error" };

  if ((await admitFeedbackSend(target.workspaceId)) === "limited") {
    return { error: FEEDBACK_RATE_LIMITED_MESSAGE, status: "error" };
  }

  const delivery = await deliverFeedback(
    {
      email: await readSessionEmail(),
      // The client mints one id per draft; a retry of the same draft reuses it.
      feedbackId: parseFeedbackId(formData.get("feedbackId")) ?? crypto.randomUUID(),
      message: parsed.message,
      page: parseFeedbackPage(formData.get("page")),
      submittedAt: new Date().toISOString(),
      workspaceId: target.workspaceId,
    },
    {
      log: console,
      // The maintainer IS the admin: the one address that can open the /admin
      // alert the mail links to.
      maintainerEmail: comparableEmail(process.env.WORTHLINE_ADMIN_EMAIL),
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

/**
 * Whether this session may send feedback — for the surfaces that cannot ask on
 * the server: the root error boundary (a client component) and the static legal
 * cover. A refusal and a failure both answer false: the button simply stays away.
 */
export async function feedbackAvailableAction(): Promise<boolean> {
  try {
    if (await isWriteBlocked()) return false;
    return canSendFeedback(await readStoreTarget());
  } catch (error) {
    console.error("[feedback] availability check failed: button hidden", {
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}
