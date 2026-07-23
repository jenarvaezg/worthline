"use server";

import { withControlPlaneStore } from "@web/admin/admin-control-plane";
import { guardAdmin } from "@web/admin/guard-admin";
import { parsePremiumUntil } from "@web/admin/parse-premium-until";
import { getBillingAdapter } from "@web/billing/get-billing-adapter";
import { billingStateFromSubscription, type EntitlementDirectory } from "@worthline/db";
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

/**
 * Re-sync manual desde el MoR (PRD #1160 S5, #1165) — la red de seguridad del
 * contrato #1135: consulta el estado real de la suscripción vía adapter y
 * reescribe la fila de entitlements con la MISMA transición que aplicaría el
 * webhook equivalente (`billingStateFromSubscription`), para el día en que un
 * webhook se pierda o llegue roto. Solo tiene sentido sobre una fila que ya
 * tiene suscripción del MoR; cualquier otro caso rebota con un flag honesto.
 */
export async function resyncWorkspaceBillingAction(formData: FormData): Promise<never> {
  await guardAdmin();

  const workspaceId = String(formData.get("workspaceId") ?? "").trim();
  if (!workspaceId) {
    redirect("/admin");
  }

  const adapter = getBillingAdapter();
  const outcome = await withControlPlaneStore(
    async (
      store: Pick<
        EntitlementDirectory,
        "readWorkspaceEntitlement" | "updateWorkspaceBilling"
      >,
    ) => {
      const current = await store.readWorkspaceEntitlement(workspaceId);
      if (!current?.subscriptionId || !current.billingProvider) {
        return "sin-suscripcion";
      }
      if (!adapter || adapter.provider !== current.billingProvider) {
        return "sin-adapter";
      }
      const state = await adapter.readSubscription(current.subscriptionId);
      if (!state) {
        return "desconocida";
      }
      await store.updateWorkspaceBilling({
        workspaceId,
        ...billingStateFromSubscription(current, {
          provider: current.billingProvider,
          subscriptionId: current.subscriptionId,
          state,
          nowIso: new Date().toISOString(),
        }),
      });
      return "ok";
    },
  );

  redirect(outcome === "ok" ? "/admin" : "/admin?entError=resync");
}
