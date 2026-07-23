import {
  type AiTokenUsage,
  createControlPlaneStore,
  type UsageLimits,
} from "@worthline/db";

/**
 * The token meter's persistence half (PRD #1160 S3, #1163). Two operations over
 * the control-plane counter, mirroring the ADR 0051 stores:
 *
 *  - {@link readAiTokenUsage} reads the day's workspace + global totals for the
 *    pre-call gate.
 *  - {@link recordAiTokenUsage} adds a finished turn's tokens to both counters.
 *
 * Both return/no-op in local dev (no control-plane URL) — unmetered, the
 * developer owns the key, exactly like the rate limit and courtesy quota.
 */

type TokenMeterPort = Pick<UsageLimits, "readAiTokenUsage" | "recordAiTokenUsage">;

function controlPlaneConfig(): { url: string; authToken?: string } | null {
  const url = process.env["WORTHLINE_CONTROL_PLANE_DB_URL"];
  if (!url) return null;
  const authToken = process.env["WORTHLINE_DB_AUTH_TOKEN"];
  return { url, ...(authToken ? { authToken } : {}) };
}

/**
 * Open the control-plane token-meter port, hand it to `run`, and always close
 * it — or return null without touching a store when unmetered (local dev, no
 * URL). One opener for both operations, as `provider-cooldown-store` does.
 */
async function withTokenMeter<T>(
  run: (store: TokenMeterPort) => Promise<T>,
): Promise<T | null> {
  const config = controlPlaneConfig();
  if (!config) return null;
  const controlPlane: TokenMeterPort & { close(): void } =
    await createControlPlaneStore(config);
  try {
    return await run(controlPlane);
  } finally {
    controlPlane.close();
  }
}

/** The day's accumulated token totals, or null when unmetered (local dev). */
export async function readAiTokenUsage(
  workspaceId: string,
  dayKey: string,
): Promise<AiTokenUsage | null> {
  return withTokenMeter((store) => store.readAiTokenUsage(workspaceId, dayKey));
}

/** Add a finished turn's tokens to the workspace + global daily counters. No-op when unmetered. */
export async function recordAiTokenUsage(
  workspaceId: string,
  dayKey: string,
  tokens: number,
): Promise<void> {
  await withTokenMeter((store) => store.recordAiTokenUsage(workspaceId, dayKey, tokens));
}
