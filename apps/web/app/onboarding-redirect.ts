import { ONBOARDING_PATH } from "@web/asistente/screen-context";
import type { StoreTarget } from "@web/store-resolver";
import { createControlPlaneStore, type WorkspaceEntitlement } from "@worthline/db";

export { ONBOARDING_PATH };

/**
 * The post-registration redirect gate of PRD #1167 S1 (#1168): a
 * freshly-provisioned hosted workspace lands on the full-screen onboarding
 * (`/bienvenida`) instead of the empty dashboard, until it has onboarded.
 *
 * Pure decision (the row is read by {@link readOnboardingEntryRedirect}) so it
 * unit-tests without a database.
 *
 * Gated ONLY for a hosted authenticated workspace acting on its own account:
 *  - `local`/`demo`/`unauthenticated` never carry an entitlement row and are
 *    never force-redirected (they may still visit `/bienvenida` directly).
 *  - An impersonating admin (#697) is viewing someone else's workspace read-only
 *    — never trap them in that user's onboarding.
 *
 * «Onboarded» is either mark being present: `onboardedAt` (completed `/bienvenida`
 * or the explicit «lo haré luego»), OR `firstHoldingAt` — a workspace that already
 * holds something is live and must never be forced back, even if the onboarded
 * mark was missed (both are best-effort set-once, #1131). A missing row reads as
 * a brand-new workspace, so it enters onboarding.
 */
export function shouldEnterOnboarding(
  target: StoreTarget,
  entitlement: WorkspaceEntitlement | null,
): boolean {
  if (target.kind !== "authenticated" || target.impersonatedEmail !== undefined) {
    return false;
  }
  if (!entitlement) return true;
  return entitlement.onboardedAt === null && entitlement.firstHoldingAt === null;
}

/**
 * Resolve the onboarding entry redirect for a target: `ONBOARDING_PATH` when the
 * hosted workspace should be sent to onboarding, otherwise `null`.
 *
 * Fail-open by design (the opposite of the ingestion gate): a non-authenticated
 * target, a missing control-plane URL, or a read that throws all resolve to
 * `null` — never trap a user in a redirect on a transient control-plane error.
 * The worst case is one missed nudge to onboarding, recoverable on the next load.
 */
export async function readOnboardingEntryRedirect(
  target: StoreTarget,
): Promise<string | null> {
  if (target.kind !== "authenticated" || target.impersonatedEmail !== undefined) {
    return null;
  }

  const url = process.env["WORTHLINE_CONTROL_PLANE_DB_URL"];
  if (!url) {
    return null;
  }

  const authToken = process.env["WORTHLINE_DB_AUTH_TOKEN"];
  try {
    const controlPlane = await createControlPlaneStore({
      url,
      ...(authToken ? { authToken } : {}),
    });
    try {
      const entitlement = await controlPlane.readWorkspaceEntitlement(target.workspaceId);
      return shouldEnterOnboarding(target, entitlement) ? ONBOARDING_PATH : null;
    } finally {
      controlPlane.close();
    }
  } catch (error) {
    console.warn(
      `onboarding: could not read the entitlement for workspace ${target.workspaceId}; not redirecting`,
      error,
    );
    return null;
  }
}
