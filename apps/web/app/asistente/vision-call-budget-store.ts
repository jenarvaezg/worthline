import { withOptionalControlPlaneStore } from "@web/control-plane-store";
import type { UsageLimits, VisionCallUsage } from "@worthline/db";

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

/** Open the control-plane vision meter, hand it to `run`, and always close it. */
function withVisionMeter<T>(
  run: (store: VisionMeterPort) => Promise<T>,
): Promise<T | null> {
  return withOptionalControlPlaneStore<T, VisionMeterPort>(run);
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
