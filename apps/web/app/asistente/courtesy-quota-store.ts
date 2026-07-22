import { createControlPlaneStore, type UsageLimits } from "@worthline/db";

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
  const url = process.env["WORTHLINE_CONTROL_PLANE_DB_URL"];
  if (!url) {
    return null;
  }

  const authToken = process.env["WORTHLINE_DB_AUTH_TOKEN"];
  const controlPlane: Pick<UsageLimits, "recordAssistantCourtesyUse"> & {
    close(): void;
  } = await createControlPlaneStore({
    url,
    ...(authToken ? { authToken } : {}),
  });
  try {
    return await controlPlane.recordAssistantCourtesyUse(rateKey, monthKey);
  } finally {
    controlPlane.close();
  }
}
