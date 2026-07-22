import { createControlPlaneStore, type UsageLimits } from "@worthline/db";

/**
 * The rate limit's persistence half (ADR 0051): count this request in the
 * control plane and return the running count for the window. Returns null in
 * local dev (no control-plane URL) — unmetered, the developer owns the key.
 */
export async function countChatRequest(
  rateKey: string,
  windowKey: string,
): Promise<number | null> {
  const url = process.env["WORTHLINE_CONTROL_PLANE_DB_URL"];
  if (!url) {
    return null;
  }

  const authToken = process.env["WORTHLINE_DB_AUTH_TOKEN"];
  const controlPlane: Pick<UsageLimits, "recordChatRequest"> & { close(): void } =
    await createControlPlaneStore({
      url,
      ...(authToken ? { authToken } : {}),
    });
  try {
    return await controlPlane.recordChatRequest(rateKey, windowKey);
  } finally {
    controlPlane.close();
  }
}
