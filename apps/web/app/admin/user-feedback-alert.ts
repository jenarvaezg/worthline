import type { RaiseMaintainerAlertInput } from "@worthline/db";

/**
 * The user-feedback maintainer-alert contract (#1174, ADR 0064 amended).
 *
 * The in-app «Enviar feedback» button writes ONE submission to two places: this
 * alert in the control plane (so it lives in `/admin` whatever happens to the
 * mail) and an email to the maintainer. This module owns the alert half; the
 * `/admin` surfaces read it back through {@link isUserFeedbackPayload}.
 *
 * Shape of the alert, and why:
 *   - `category: "user_feedback"` — the first category a PERSON raises. It is
 *     absent from the chat tool's enum: the assistant cannot send feedback on the
 *     user's behalf, it can only point at the button.
 *   - `workspaceId` is the REAL workspace: which user wrote is half the answer.
 *   - `holdingId` is the `feedback:<id>` sentinel, one per message. With a
 *     per-workspace subject the dedup key (`workspace + holding + category`)
 *     would pile a second, unrelated message onto the first as an «occurrence»,
 *     and closing one would close both. A message is an incident of its own.
 *   - Control plane, never the workspace database: like every alert, the text is
 *     unexportable with a workspace — and it may carry personal financial context.
 *     For the same reason there is no GitHub issue: the repository is public.
 */

const HOLDING_ID_PREFIX = "feedback:";

/** What the user sent, plus what the maintainer needs to answer it. */
export interface UserFeedbackSubmission {
  workspaceId: string;
  /**
   * The message's own id — minted by the client once per draft, so a retry of the
   * same draft accumulates on the same alert and reuses the email's idempotency
   * key instead of minting duplicates of both.
   */
  feedbackId: string;
  message: string;
  /** The signed-in address the user can be answered at, or null when unknown. */
  email: string | null;
  /** The pathname the user was on, or null when it did not arrive. */
  page: string | null;
  submittedAt: string;
}

/** The forensic payload of one feedback message — stored verbatim as JSON. */
export interface UserFeedbackPayload {
  category: "user_feedback";
  message: string;
  email: string | null;
  page: string | null;
  submittedAt: string;
}

function userFeedbackHoldingId(feedbackId: string): string {
  return `${HOLDING_ID_PREFIX}${feedbackId}`;
}

/** One alert per message, ready for `raiseMaintainerAlert`. Pure. */
export function buildUserFeedbackAlert(
  submission: UserFeedbackSubmission,
): RaiseMaintainerAlertInput & { payload: UserFeedbackPayload } {
  return {
    workspaceId: submission.workspaceId,
    holdingId: userFeedbackHoldingId(submission.feedbackId),
    category: "user_feedback",
    occurredAt: submission.submittedAt,
    payload: {
      category: "user_feedback",
      message: submission.message,
      email: submission.email,
      page: submission.page,
      submittedAt: submission.submittedAt,
    },
  };
}

const isNullableString = (value: unknown): boolean =>
  value === null || typeof value === "string";

/**
 * Whether a stored occurrence payload is a feedback one. Structural, not trusting:
 * payloads are opaque JSON frozen at raise time, so the detail surface checks every
 * field it dereferences before rendering it.
 */
export function isUserFeedbackPayload(value: unknown): value is UserFeedbackPayload {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as Partial<UserFeedbackPayload>;
  return (
    candidate.category === "user_feedback" &&
    typeof candidate.message === "string" &&
    typeof candidate.submittedAt === "string" &&
    isNullableString(candidate.email) &&
    isNullableString(candidate.page)
  );
}
