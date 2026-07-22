import type { StoreTarget } from "@web/store-resolver";
import { createControlPlaneStore, type EntitlementPlan } from "@worthline/db";

import { effectivePlanForTarget } from "./effective-plan";

/**
 * Read the effective entitlement plan for a resolved target (PRD #1160 S2,
 * #1162). Non-authenticated targets resolve purely by kind; an authenticated
 * one reads its stored row from the control plane and derives (S1's
 * `deriveEffectivePlan`, honored via {@link effectivePlanForTarget}).
 *
 * Fail-closed by design: an authenticated target with no control-plane URL, or a
 * read that throws, resolves to `free`. The gate protects INGESTION only, so a
 * rare transient error costs a premium caller one blocked ingestion attempt (an
 * honest paywall, retryable) — never a lost read, and never a free caller
 * slipping through. `null` from the store reads as `free` inside the pure helper
 * (a workspace with no row — the pre-#1161 migration story).
 */
export async function readEffectivePlan(
  target: StoreTarget,
  nowIso: string = new Date().toISOString(),
): Promise<EntitlementPlan> {
  if (target.kind !== "authenticated") {
    return effectivePlanForTarget(target, null, nowIso);
  }

  const url = process.env["WORTHLINE_CONTROL_PLANE_DB_URL"];
  if (!url) {
    return "free";
  }

  const authToken = process.env["WORTHLINE_DB_AUTH_TOKEN"];
  try {
    const controlPlane = await createControlPlaneStore({
      url,
      ...(authToken ? { authToken } : {}),
    });
    try {
      const entitlement = await controlPlane.readWorkspaceEntitlement(target.workspaceId);
      return effectivePlanForTarget(target, entitlement, nowIso);
    } finally {
      controlPlane.close();
    }
  } catch (error) {
    console.warn(
      `entitlements: could not read the plan for workspace ${target.workspaceId}; gating ingestion as free`,
      error,
    );
    return "free";
  }
}
