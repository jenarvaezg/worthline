"use server";

import { withControlPlaneStore } from "@web/admin/admin-control-plane";
import { guardAdmin } from "@web/admin/guard-admin";
import { parsePremiumUntil } from "@web/admin/parse-premium-until";
import type { EntitlementDirectory } from "@worthline/db";
import { redirect } from "next/navigation";

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
