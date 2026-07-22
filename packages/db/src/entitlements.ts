/**
 * Entitlements (PRD #1160 S1, #1161): the control plane's notion of what a
 * workspace may use — `free | trial | premium` — derived SERVER-SIDE from one
 * row, never from a hot merchant-of-record query. The MoR (and the admin
 * palanca) only FEED the stored row via webhooks/actions; every surface asks
 * {@link deriveEffectivePlan} at read time, so a lapsed trial or a cancelled
 * subscription falls back honestly without any expiry job.
 *
 * A workspace WITHOUT a row is `free` with no trial consumed — which is also
 * the whole migration story for pre-#1161 workspaces (decision in the slice:
 * existing workspaces → free; premium-de-beta arrives via the manual grant).
 */

/** The three exact entitlement states (#1127/#1128) — no fourth. */
export type EntitlementPlan = "free" | "trial" | "premium";

/**
 * The stored entitlement row, kept in the control plane beside the grant
 * (#1161, seam #998). `plan` is the DECLARED state (what provisioning, the
 * admin palanca, or a billing webhook last asserted); the dates cap it — the
 * effective state is always {@link deriveEffectivePlan}, never `plan` read raw.
 * The `onboardedAt`/`firstHoldingAt` activation timestamps (#1131) say only
 * THAT something happened, never what the workspace holds.
 */
export interface WorkspaceEntitlement {
  workspaceId: string;
  plan: EntitlementPlan;
  /** When the trial window closes (ISO), or null when no trial was started. */
  trialEndsAt: string | null;
  /**
   * Until when premium holds (ISO): a dated manual grant, or the paid period's
   * end after a cancellation. Null on a `premium` plan means indefinite (the
   * admin palanca's lifetime/beta grant).
   */
  premiumUntil: string | null;
  /** Merchant-of-record references (S5 fills these; null until then). */
  billingProvider: string | null;
  billingCustomerId: string | null;
  subscriptionId: string | null;
  subscriptionStatus: string | null;
  /** Set-once activation timestamps (#1131): that it happened, never what. */
  onboardedAt: string | null;
  firstHoldingAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Trial length (#1128, plan de salida comercial): 3 días, automático, sin tarjeta. */
export const TRIAL_DURATION_DAYS = 3;

const DAY_MS = 24 * 60 * 60 * 1000;

/** The trial window's closing instant for a trial starting at `nowIso`. */
export function trialEndsAtFrom(nowIso: string): string {
  return new Date(Date.parse(nowIso) + TRIAL_DURATION_DAYS * DAY_MS).toISOString();
}

/**
 * The single derivation gate (#1161): stored row + "now" → effective plan.
 *
 * Order matters and encodes the contract:
 *  1. `premium` — an indefinite premium plan (manual grant), OR any row whose
 *     `premiumUntil` is still in the future. The date is honored regardless of
 *     the declared plan, so an end-of-period-after-cancel (plan already flipped
 *     by a webhook) keeps what was paid for.
 *  2. `trial` — a live trial window.
 *  3. `free` — everything else, including the missing row.
 */
export function deriveEffectivePlan(
  entitlement: Pick<WorkspaceEntitlement, "plan" | "premiumUntil" | "trialEndsAt"> | null,
  nowIso: string,
): EntitlementPlan {
  if (!entitlement) return "free";
  const now = Date.parse(nowIso);

  if (entitlement.plan === "premium" && entitlement.premiumUntil === null) {
    return "premium";
  }
  if (entitlement.premiumUntil !== null && Date.parse(entitlement.premiumUntil) > now) {
    return "premium";
  }
  if (entitlement.trialEndsAt !== null && Date.parse(entitlement.trialEndsAt) > now) {
    return "trial";
  }
  return "free";
}
