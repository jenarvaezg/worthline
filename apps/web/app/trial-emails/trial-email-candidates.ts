/**
 * Who is in a trial window right now, with what the trial emails (#1173) need
 * to decide and to write — composed through the control plane's PORTS, not a
 * cross-table query (ADR 0087: a port owns its tables):
 *
 *   entitlements (who trials, until when, what plan now)
 *     → tenancy (whose workspace, at which address)
 *     → trial-email ledger (what was already sent, what was declined).
 *
 * One list of entitlement rows, then three small reads per identity in a window.
 * Only trials that close after the cutoff reach the per-identity reads, so the
 * cost tracks the handful in flight, not the fleet.
 */

import type {
  EffectivePlanInput,
  EntitlementDirectory,
  TenancyDirectory,
  TrialEmailLedger,
  TrialEmailMarks,
} from "@worthline/db";

/** One trialing identity: its entitlement (for the plan), its address and its marks. */
export interface TrialEmailCandidate extends EffectivePlanInput, TrialEmailMarks {
  /** Always set here: a candidate IS a workspace with a trial window. */
  trialEndsAt: string;
  userId: string;
  email: string;
  workspaceId: string;
}

/** The narrow read surface the composition needs — nothing that writes. */
export type TrialEmailCandidatePorts = Pick<
  EntitlementDirectory,
  "listWorkspaceEntitlements"
> &
  Pick<TenancyDirectory, "getWorkspaceWithOwner" | "findUserByEmail"> &
  Pick<TrialEmailLedger, "readTrialEmailMarks">;

export async function listTrialEmailCandidates(
  ports: TrialEmailCandidatePorts,
  { trialEndsAfter }: { trialEndsAfter: string },
): Promise<TrialEmailCandidate[]> {
  const cutoff = Date.parse(trialEndsAfter);
  const inWindow = (await ports.listWorkspaceEntitlements())
    .flatMap((entitlement) =>
      entitlement.trialEndsAt !== null && Date.parse(entitlement.trialEndsAt) > cutoff
        ? [{ ...entitlement, trialEndsAt: entitlement.trialEndsAt }]
        : [],
    )
    .sort((left, right) => left.trialEndsAt.localeCompare(right.trialEndsAt));

  const candidates: TrialEmailCandidate[] = [];
  for (const entitlement of inWindow) {
    // The owner is the workspace's oldest grant (one owner per user, #733).
    const workspace = await ports.getWorkspaceWithOwner(entitlement.workspaceId);
    const owner = workspace?.ownerEmail
      ? await ports.findUserByEmail(workspace.ownerEmail)
      : null;
    if (!owner) continue;
    candidates.push({
      ...(await ports.readTrialEmailMarks(owner.id)),
      email: owner.email,
      plan: entitlement.plan,
      premiumUntil: entitlement.premiumUntil,
      trialEndsAt: entitlement.trialEndsAt,
      userId: owner.id,
      workspaceId: entitlement.workspaceId,
    });
  }
  return candidates;
}
