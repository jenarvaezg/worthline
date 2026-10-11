import {
  buildUserFeedbackAlert,
  type UserFeedbackSubmission,
} from "@web/admin/user-feedback-alert";
import type { EmailMessage, SendEmailResult } from "@web/email/send-email";
import type { RaiseMaintainerAlertInput } from "@worthline/db";

/**
 * One feedback submission, two destinations (#1174): the `/admin` alert (ADR 0064)
 * and an email to the maintainer. Neither waits on the other and neither can lose
 * the message for the other:
 *
 *   - the alert is written first, because it is the durable copy the maintainer
 *     can always come back to;
 *   - the email goes out whatever happened to the alert — if the control plane
 *     is down, the mail is the only copy, and it says so;
 *   - a missing Resend key or maintainer address skips the mail with a log line,
 *     never an error: the alert already holds the message.
 *
 * Only when NEITHER destination took the message is it reported as undelivered,
 * so the form can keep the draft and offer a retry instead of saying «recibido».
 *
 * The message text never goes to the server logs: it may carry personal financial
 * context, and the logs are not a place the user agreed to put it.
 */

export interface DeliverFeedbackDeps {
  /** The control-plane write; null when no control plane is configured. */
  raiseAlert(input: RaiseMaintainerAlertInput): Promise<{ alert: { id: string } } | null>;
  sendEmail(message: EmailMessage): Promise<SendEmailResult>;
  /** Where the mail goes — the maintainer, i.e. the admin who reads `/admin`. */
  maintainerEmail: string | null;
  /** Absolute origin for the link to the alert. */
  siteUrl: string;
  log: Pick<Console, "error" | "info" | "warn">;
}

export interface FeedbackDelivery {
  /** True when at least one destination holds the message. */
  delivered: boolean;
  alert: "written" | "unavailable" | "failed";
  email: SendEmailResult["status"] | "no_recipient";
}

const SUBJECT_PREVIEW_LENGTH = 70;

/** The first line, cut short: enough to triage from the inbox. */
function subjectPreview(message: string): string {
  const firstLine = message.split(/\r?\n/, 1)[0]?.trim() ?? "";
  return firstLine.length > SUBJECT_PREVIEW_LENGTH
    ? `${firstLine.slice(0, SUBJECT_PREVIEW_LENGTH - 1)}…`
    : firstLine;
}

function feedbackEmail(
  submission: UserFeedbackSubmission,
  to: string,
  alertUrl: string | null,
): EmailMessage {
  const lines = [
    submission.message,
    "",
    "—",
    `De: ${submission.email ?? "correo no disponible"}`,
    `Workspace: ${submission.workspaceId}`,
    `Pantalla: ${submission.page ?? "desconocida"}`,
    `Enviado: ${submission.submittedAt}`,
    alertUrl
      ? `En /admin: ${alertUrl}`
      : "En /admin: la alerta NO se pudo escribir; este correo es la única copia.",
  ];
  return {
    idempotencyKey: `feedback-${submission.feedbackId}`,
    subject: `Feedback de worthline: ${subjectPreview(submission.message)}`,
    tags: [{ name: "kind", value: "user_feedback" }],
    text: lines.join("\n"),
    to,
    ...(submission.email ? { replyTo: submission.email } : {}),
  };
}

export async function deliverFeedback(
  submission: UserFeedbackSubmission,
  deps: DeliverFeedbackDeps,
): Promise<FeedbackDelivery> {
  const context = {
    feedbackId: submission.feedbackId,
    workspaceId: submission.workspaceId,
  };

  let alert: FeedbackDelivery["alert"];
  let alertId: string | null = null;
  try {
    const raised = await deps.raiseAlert(buildUserFeedbackAlert(submission));
    alert = raised ? "written" : "unavailable";
    alertId = raised?.alert.id ?? null;
    if (!raised) {
      deps.log.warn("[feedback] no control plane configured: alert not written", context);
    }
  } catch (error) {
    alert = "failed";
    deps.log.error("[feedback] alert write failed", {
      ...context,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  let email: FeedbackDelivery["email"];
  if (!deps.maintainerEmail) {
    email = "no_recipient";
    deps.log.warn("[feedback] WORTHLINE_ADMIN_EMAIL not set: email skipped", context);
  } else {
    const alertUrl = alertId ? `${deps.siteUrl}/admin/alertas/${alertId}` : null;
    const result = await deps.sendEmail(
      feedbackEmail(submission, deps.maintainerEmail, alertUrl),
    );
    email = result.status;
    if (result.status === "skipped") {
      deps.log.info("[feedback] RESEND_API_KEY not set: email skipped", context);
    } else if (result.status === "failed") {
      deps.log.error("[feedback] email failed", {
        ...context,
        error: result.error,
        httpStatus: result.httpStatus,
      });
    }
  }

  return { alert, delivered: alert === "written" || email === "sent", email };
}
