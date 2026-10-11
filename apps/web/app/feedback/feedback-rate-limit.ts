import { withOptionalControlPlaneStore } from "@web/control-plane-store";
import type { UsageLimits } from "@worthline/db";

/**
 * How many feedback messages one workspace may send per UTC hour (#1174).
 *
 * Each message is its own maintainer alert and its own email (no dedup by
 * design), and registration is open, so without a ceiling one account in a loop
 * would fill the control plane and spend the Resend quota the trial emails (#1173)
 * also need. Five an hour is far above what a person reporting real problems
 * writes, and low enough that a loop stops at once.
 */
export const FEEDBACK_SENDS_PER_HOUR = 5;

export const FEEDBACK_RATE_LIMITED_MESSAGE =
  `Ya has enviado ${FEEDBACK_SENDS_PER_HOUR} mensajes en esta hora, que es el máximo. ` +
  "Tu mensaje sigue aquí: podrás enviarlo en cuanto empiece la hora siguiente.";

type RecordFeedbackSubmission = (
  rateKey: string,
  windowKey: string,
) => Promise<number | null>;

function recordInControlPlane(rateKey: string, windowKey: string) {
  return withOptionalControlPlaneStore<
    number,
    Pick<UsageLimits, "recordFeedbackSubmission">
  >((controlPlane) => controlPlane.recordFeedbackSubmission(rateKey, windowKey));
}

/**
 * Count this send and decide whether it may go. Increment-then-check over the
 * control-plane counter (the ADR 0051 mechanism): one atomic upsert hands every
 * concurrent send its own running total, so the limit holds under a race.
 *
 * Fails OPEN — with a log line — when the counter cannot be read: it lives in
 * the same control plane as the alert, so in that outage the email may be the
 * message's only copy, and a counter that is down is not a reason to drop it.
 */
export async function admitFeedbackSend(
  workspaceId: string,
  {
    log = console,
    now = new Date().toISOString(),
    record = recordInControlPlane,
  }: {
    log?: Pick<Console, "error">;
    now?: string;
    record?: RecordFeedbackSubmission;
  } = {},
): Promise<"ok" | "limited"> {
  try {
    const count = await record(`ws:${workspaceId}`, now.slice(0, 13));
    return count !== null && count > FEEDBACK_SENDS_PER_HOUR ? "limited" : "ok";
  } catch (error) {
    log.error("[feedback] rate counter unavailable: send admitted", {
      error: error instanceof Error ? error.message : String(error),
      workspaceId,
    });
    return "ok";
  }
}
