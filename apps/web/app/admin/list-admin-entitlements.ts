import { withControlPlaneStore } from "@web/admin/admin-control-plane";
import {
  type ControlPlaneWorkspaceWithOwner,
  deriveEffectivePlan,
  type EntitlementDirectory,
  type EntitlementPlan,
  type TenancyDirectory,
  type UsageLimits,
  type WorkspaceDailyTokenUsage,
  type WorkspaceEntitlement,
} from "@worthline/db";

/**
 * One workspace's entitlement state for the /admin palanca (PRD #1160 S4,
 * #1164): the DERIVED effective plan (the only honest state — `deriveEffectivePlan`,
 * never a stored `plan` read raw), the raw fields the maintainer needs to
 * reason about a grant, the merchant-of-record refs (S5 fills these), and the
 * workspace's own AI token spend today. Aggregate only — never any content.
 */
export interface AdminEntitlementRow {
  workspaceId: string;
  ownerEmail: string | null;
  createdAt: string;
  /** The honest, derived state (`free | trial | premium`). */
  effectivePlan: EntitlementPlan;
  /** The stored/declared plan, or null when the workspace has no row (reads as free). */
  declaredPlan: EntitlementPlan | null;
  trialEndsAt: string | null;
  premiumUntil: string | null;
  /** Effective premium with no window: an indefinite manual/lifetime grant (#1133). */
  isIndefinitePremium: boolean;
  billingProvider: string | null;
  subscriptionId: string | null;
  subscriptionStatus: string | null;
  /** The workspace's AI token total today (UTC), zero when it has none. */
  tokensToday: number;
}

/**
 * Pure join (testable without a DB): every workspace, enriched with its stored
 * entitlement row (if any), the derived effective plan at `now`, and today's
 * per-workspace token spend. Workspaces are the spine — one row each, oldest
 * first as `listWorkspacesWithOwners` already orders them — so a workspace with
 * no entitlement row still appears (as `free`).
 */
export function buildAdminEntitlementRows(input: {
  workspaces: ControlPlaneWorkspaceWithOwner[];
  entitlements: WorkspaceEntitlement[];
  tokenUsage: WorkspaceDailyTokenUsage[];
  now: string;
}): AdminEntitlementRow[] {
  const entitlementById = new Map(input.entitlements.map((e) => [e.workspaceId, e]));
  const tokensById = new Map(input.tokenUsage.map((t) => [t.workspaceId, t.tokens]));

  return input.workspaces.map((workspace) => {
    const entitlement = entitlementById.get(workspace.id) ?? null;
    const effectivePlan = deriveEffectivePlan(entitlement, input.now);
    return {
      workspaceId: workspace.id,
      ownerEmail: workspace.ownerEmail,
      createdAt: workspace.createdAt,
      effectivePlan,
      declaredPlan: entitlement?.plan ?? null,
      trialEndsAt: entitlement?.trialEndsAt ?? null,
      premiumUntil: entitlement?.premiumUntil ?? null,
      isIndefinitePremium:
        effectivePlan === "premium" && (entitlement?.premiumUntil ?? null) === null,
      billingProvider: entitlement?.billingProvider ?? null,
      subscriptionId: entitlement?.subscriptionId ?? null,
      subscriptionStatus: entitlement?.subscriptionStatus ?? null,
      tokensToday: tokensById.get(workspace.id) ?? 0,
    };
  });
}

type EntitlementViewStore = Pick<TenancyDirectory, "listWorkspacesWithOwners"> &
  Pick<EntitlementDirectory, "listWorkspaceEntitlements"> &
  Pick<UsageLimits, "listWorkspaceAiTokenUsage">;

/**
 * The /admin entitlements view (#1164): join workspaces, their stored
 * entitlement rows, and today's per-workspace token spend into one derived row
 * per workspace. Three reads over the single control-plane connection, then the
 * pure {@link buildAdminEntitlementRows}. `now` is injectable so tests are
 * deterministic; today's UTC day keys the token read.
 */
export async function listAdminEntitlements(
  now: string = new Date().toISOString(),
  injectedStore?: EntitlementViewStore,
): Promise<AdminEntitlementRow[]> {
  const dayKey = now.slice(0, 10);
  return withControlPlaneStore(async (store: EntitlementViewStore) => {
    const [workspaces, entitlements, tokenUsage] = await Promise.all([
      store.listWorkspacesWithOwners(),
      store.listWorkspaceEntitlements(),
      store.listWorkspaceAiTokenUsage(dayKey),
    ]);
    return buildAdminEntitlementRows({ workspaces, entitlements, tokenUsage, now });
  }, injectedStore);
}
