"use server";

import { withControlPlaneStore } from "@web/admin/admin-control-plane";
import { guardAdmin } from "@web/admin/guard-admin";
import type { EntitlementDirectory } from "@worthline/db";
import { redirect } from "next/navigation";

/**
 * Parse the grant form's optional date (PRD #1160 S4, #1164). Pure and
 * injectable-`now`, so the future check is deterministic under test.
 *
 *  - Empty → an INDEFINITE grant (`premiumUntil: null`) — the beta/lifetime carril.
 *  - A `YYYY-MM-DD` strictly in the future → premium THROUGH the end of that day
 *    (UTC `23:59:59.999`), so a same-day grant still covers the whole day.
 *  - Anything else (malformed, or today/past — which would grant a no-op) → invalid.
 */
export function parsePremiumUntil(
  raw: string,
  now: string,
): { ok: true; premiumUntil: string | null } | { ok: false } {
  const trimmed = raw.trim();
  if (trimmed === "") return { ok: true, premiumUntil: null };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return { ok: false };

  const endOfDay = `${trimmed}T23:59:59.999Z`;
  const parsed = Date.parse(endOfDay);
  if (Number.isNaN(parsed)) return { ok: false };
  // Reject an unreal calendar date: Date.parse rolls over out-of-range days
  // (2026-02-30 → Mar 2) instead of failing, so the only sound check is that the
  // parsed instant round-trips to the same UTC day the maintainer typed.
  if (new Date(parsed).toISOString().slice(0, 10) !== trimmed) return { ok: false };
  // Reject any window not strictly in the future — a past date would apply a
  // premium that derives back to free immediately, a confusing silent no-op.
  if (parsed <= Date.parse(now)) return { ok: false };
  return { ok: true, premiumUntil: endOfDay };
}

/**
 * Grant a workspace premium from /admin (#1164) — dated or indefinite. This is
 * the whole "premium gratis durante la beta" (#1133) and comps/winback
 * mechanism; no special code beyond the grant. `guardAdmin` runs FIRST, so a
 * direct POST without an admin session 404s exactly like the page. An invalid
 * date bounces back to /admin with an honest error flag rather than applying a
 * confusing no-op.
 */
export async function grantWorkspacePremiumAction(formData: FormData): Promise<never> {
  await guardAdmin();

  const workspaceId = String(formData.get("workspaceId") ?? "").trim();
  if (!workspaceId) {
    redirect("/admin");
  }

  const parsed = parsePremiumUntil(
    String(formData.get("premiumUntil") ?? ""),
    new Date().toISOString(),
  );
  if (!parsed.ok) {
    redirect("/admin?entError=fecha");
  }

  await withControlPlaneStore(
    (store: Pick<EntitlementDirectory, "grantWorkspacePremium">) =>
      store.grantWorkspacePremium({ workspaceId, premiumUntil: parsed.premiumUntil }),
  );

  redirect("/admin");
}

/**
 * Revoke a workspace's premium grant (#1164): drop it back to free, clearing
 * only the premium window (a live trial and the activation timestamps survive).
 * Guarded like every admin action.
 */
export async function revokeWorkspacePremiumAction(formData: FormData): Promise<never> {
  await guardAdmin();

  const workspaceId = String(formData.get("workspaceId") ?? "").trim();
  if (!workspaceId) {
    redirect("/admin");
  }

  await withControlPlaneStore(
    (store: Pick<EntitlementDirectory, "revokeWorkspacePremium">) =>
      store.revokeWorkspacePremium(workspaceId),
  );

  redirect("/admin");
}
