import type { StoreTarget } from "@web/store-resolver";
import {
  deriveEffectivePlan,
  type EntitlementPlan,
  type WorkspaceEntitlement,
} from "@worthline/db";

/**
 * The server-side gate of PRD #1160 S2 (#1162): map a resolved {@link StoreTarget}
 * plus its stored entitlement row to the effective `free|trial|premium` plan that
 * every premium-ingestion surface consults. Pure policy — the row is read by
 * {@link readEffectivePlan}; this module unit-tests without a database.
 *
 * The frontier is #1127's: «lo que tecleas tú, gratis para siempre; lo que la
 * máquina ingiere por ti, premium». This helper decides ONLY the plan; each
 * surface decides whether it is ingestion (gated) or manual tracking / reads
 * (always free).
 *
 * Non-authenticated targets never carry an entitlement row, so they resolve by
 * kind:
 *  - `local` — the developer owns the shared key (mirrors the ADR 0051 rate-limit
 *    bypass); everything is available.
 *  - `demo` — the public showcase must demonstrate every surface, and it is
 *    already coarsely rate-limited by IP (ADR 0051), so it bypasses to premium
 *    rather than showing a paywall on a workspace nobody can upgrade.
 *  - `unauthenticated` — no workspace, so free (and premium surfaces are
 *    unreachable anyway).
 */
export function effectivePlanForTarget(
  target: StoreTarget,
  entitlement: WorkspaceEntitlement | null,
  nowIso: string,
): EntitlementPlan {
  switch (target.kind) {
    case "local":
    case "demo":
      return "premium";
    case "authenticated":
      return deriveEffectivePlan(entitlement, nowIso);
    case "unauthenticated":
      return "free";
  }
}

/**
 * The single gate predicate: premium ingestion (attachments/document reconcile,
 * broker statement import, connected-source connect + sync, the re-runnable AI
 * wizard) is allowed for `trial` and `premium`, denied for `free`. Reads and
 * manual tracking never call this — they stay free on every plan (#1162).
 */
export function isPremiumIngestionAllowed(plan: EntitlementPlan): boolean {
  return plan !== "free";
}
