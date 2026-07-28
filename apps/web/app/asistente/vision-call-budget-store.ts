import {
  createControlPlaneStore,
  type UsageLimits,
  type VisionCallUsage,
} from "@worthline/db";

/**
 * The vision-call fuse's persistence half (#1258). Two operations over the
 * control-plane counter, mirroring `token-budget-store`:
 *
 *  - {@link readVisionCallUsage} reads the day's scope + global totals for the
 *    pre-extraction gate.
 *  - {@link recordVisionCalls} adds a finished reading's calls to both counters.
 *
 * Both return/no-op in local dev (no control-plane URL) — unmetered, the
 * developer owns the key, exactly like the rate limit, the courtesy quota and the
 * token meter.
 */

type VisionMeterPort = Pick<UsageLimits, "readVisionCallUsage" | "recordVisionCalls">;

function controlPlaneConfig(): { url: string; authToken?: string } | null {
  const url = process.env["WORTHLINE_CONTROL_PLANE_DB_URL"];
  if (!url) return null;
  const authToken = process.env["WORTHLINE_DB_AUTH_TOKEN"];
  return { url, ...(authToken ? { authToken } : {}) };
}

/** Open the control-plane vision meter, hand it to `run`, and always close it. */
async function withVisionMeter<T>(
  run: (store: VisionMeterPort) => Promise<T>,
): Promise<T | null> {
  const config = controlPlaneConfig();
  if (!config) return null;
  const controlPlane: VisionMeterPort & { close(): void } =
    await createControlPlaneStore(config);
  try {
    return await run(controlPlane);
  } finally {
    controlPlane.close();
  }
}

/** The day's accumulated readings, or null when unmetered (local dev). */
export async function readVisionCallUsage(
  scopeKey: string,
  dayKey: string,
): Promise<VisionCallUsage | null> {
  return withVisionMeter((store) => store.readVisionCallUsage(scopeKey, dayKey));
}

/** Add a finished reading's vision calls to the scope + global counters. No-op when unmetered. */
export async function recordVisionCalls(
  scopeKey: string,
  dayKey: string,
  calls: number,
): Promise<void> {
  await withVisionMeter((store) => store.recordVisionCalls(scopeKey, dayKey, calls));
}
