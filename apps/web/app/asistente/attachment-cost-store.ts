import { createControlPlaneStore, type UsageLimits } from "@worthline/db";

/**
 * The extraction fuse's persistence half (#1258), mirroring `token-budget-store`:
 * read the window's counts for the pre-call gate, add the finished reading's calls
 * afterwards. Both return/no-op in local dev (no control-plane URL) — unmetered,
 * the developer owns the key, exactly like the rate limit and the token meter.
 */

type ExtractionMeterPort = Pick<
  UsageLimits,
  "readAttachmentExtractionCalls" | "recordAttachmentExtractionCalls"
>;

function controlPlaneConfig(): { url: string; authToken?: string } | null {
  const url = process.env["WORTHLINE_CONTROL_PLANE_DB_URL"];
  if (!url) return null;
  const authToken = process.env["WORTHLINE_DB_AUTH_TOKEN"];
  return { url, ...(authToken ? { authToken } : {}) };
}

/** Open the control-plane extraction meter, hand it to `run`, and always close it. */
async function withExtractionMeter<T>(
  run: (store: ExtractionMeterPort) => Promise<T>,
): Promise<T | null> {
  const config = controlPlaneConfig();
  if (!config) return null;
  const controlPlane: ExtractionMeterPort & { close(): void } =
    await createControlPlaneStore(config);
  try {
    return await run(controlPlane);
  } finally {
    controlPlane.close();
  }
}

/**
 * The window's vision-call count per rate key. One connection for every bucket a
 * caller answers to (demo answers to two), so the gate costs one control-plane open,
 * not one per bucket. Keyed rather than positional so the gate cannot mis-pair a
 * count with a ceiling. Null when unmetered (local dev, or a caller with no bucket).
 */
export async function readVisionCallCounts(
  rateKeys: readonly string[],
  windowKey: string,
): Promise<Record<string, number> | null> {
  if (rateKeys.length === 0) return null;
  return withExtractionMeter(async (store) => {
    const counts: Record<string, number> = {};
    for (const rateKey of rateKeys) {
      counts[rateKey] = await store.readAttachmentExtractionCalls(rateKey, windowKey);
    }
    return counts;
  });
}

/** Add a finished reading's vision calls to every bucket. No-op when unmetered or zero. */
export async function recordVisionCalls(
  rateKeys: readonly string[],
  windowKey: string,
  calls: number,
): Promise<void> {
  if (rateKeys.length === 0 || calls <= 0) return;
  await withExtractionMeter(async (store) => {
    for (const rateKey of rateKeys) {
      await store.recordAttachmentExtractionCalls(rateKey, windowKey, calls);
    }
  });
}
