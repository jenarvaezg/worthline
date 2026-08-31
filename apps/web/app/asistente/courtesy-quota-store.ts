import { withOptionalControlPlaneStore } from "@web/control-plane-store";
import type { UsageLimits } from "@worthline/db";

/**
 * The courtesy quota's persistence half (PRD #1160 S2, #1162): count this
 * free-plan assistant turn in the control plane and return the running monthly
 * count. Returns null in local dev (no control-plane URL) — unmetered, the
 * developer owns the key. Mirrors {@link countChatRequest} (ADR 0051), on its
 * own table so the monthly product quota and the hourly throttle never
 * interfere.
 */
export async function countAssistantCourtesyUse(
  rateKey: string,
  monthKey: string,
): Promise<number | null> {
  return withOptionalControlPlaneStore<
    number,
    Pick<UsageLimits, "recordAssistantCourtesyUse">
  >((controlPlane) => controlPlane.recordAssistantCourtesyUse(rateKey, monthKey));
}
