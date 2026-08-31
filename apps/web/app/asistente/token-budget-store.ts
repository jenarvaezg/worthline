import { withOptionalControlPlaneStore } from "@web/control-plane-store";
import type { AiTokenUsage, UsageLimits } from "@worthline/db";

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

/**
 * Open the control-plane token-meter port, hand it to `run`, and always close
 * it — or return null without touching a store when unmetered (local dev, no
 * URL). One opener for both operations, over the shared helper (#1694).
 */
function withTokenMeter<T>(
  run: (store: TokenMeterPort) => Promise<T>,
): Promise<T | null> {
  return withOptionalControlPlaneStore<T, TokenMeterPort>(run);
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
