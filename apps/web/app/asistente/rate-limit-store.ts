import { withOptionalControlPlaneStore } from "@web/control-plane-store";
import type { UsageLimits } from "@worthline/db";

/**
 * The rate limit's persistence half (ADR 0051): count this request in the
 * control plane and return the running count for the window. Returns null in
 * local dev (no control-plane URL) — unmetered, the developer owns the key.
 */
export async function countChatRequest(
  rateKey: string,
  windowKey: string,
): Promise<number | null> {
  return withOptionalControlPlaneStore<number, Pick<UsageLimits, "recordChatRequest">>(
    (controlPlane) => controlPlane.recordChatRequest(rateKey, windowKey),
  );
}
