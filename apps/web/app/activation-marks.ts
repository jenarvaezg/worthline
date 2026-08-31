import type { EntitlementDirectory } from "@worthline/db";

import { controlPlaneTargetFromEnv, withControlPlaneStore } from "./control-plane-store";
import { readStoreTarget } from "./read-store-target";
import type { StoreTarget } from "./store-resolver";

/**
 * Best-effort activation marks (#1131, PRD #1160 S1): stamp the workspace's
 * set-once `onboarded_at` / `first_holding_at` in the control plane after the
 * mutation that means it — completing `/empezar`, or persisting a holding for
 * the first time (wizard, inversiones, chat, statement import). They say only
 * THAT it happened, never what the workspace holds — the beta gate reads them
 * (#1133), nothing else does.
 *
 * Best-effort by design, like {@link ensureExposureCatalogStubs}: called from
 * `afterCommit` seams, so it can NEVER block or fail the write that triggered
 * it. Set-once lives in the control plane (COALESCE upsert), so calling on
 * every later write is harmless — no "is this the first?" read here.
 *
 * - Demo/local/no control plane → no-op (only a hosted authenticated workspace
 *   has a row to stamp).
 * - Any resolve/open/write failure is swallowed: a missed stamp costs one
 *   set-once timestamp, and the next qualifying write retries it.
 */
async function markActivation(
  mark: keyof Pick<
    EntitlementDirectory,
    "markWorkspaceFirstHolding" | "markWorkspaceOnboarded"
  >,
  target?: StoreTarget,
): Promise<void> {
  // Probed BEFORE resolving the target: with no control plane there is no row to
  // stamp, and this runs from `afterCommit` seams where a target resolve is a
  // cookie read worth skipping entirely.
  const controlPlane = controlPlaneTargetFromEnv();
  if (!controlPlane) {
    return;
  }

  try {
    const resolved = target ?? (await readStoreTarget());
    if (resolved.kind !== "authenticated") {
      return;
    }
    await withControlPlaneStore<void, Pick<EntitlementDirectory, typeof mark>>(
      (store) => store[mark](resolved.workspaceId, new Date().toISOString()),
      { target: controlPlane },
    );
  } catch {
    // Best-effort: the caller's write already committed and must not fail.
  }
}

/** Stamp `onboarded_at` (set-once) — call after `/empezar` completes. */
export async function markOnboardedBestEffort(target?: StoreTarget): Promise<void> {
  await markActivation("markWorkspaceOnboarded", target);
}

/** Stamp `first_holding_at` (set-once) — call after a holding-creating write. */
export async function markFirstHoldingBestEffort(target?: StoreTarget): Promise<void> {
  await markActivation("markWorkspaceFirstHolding", target);
}
