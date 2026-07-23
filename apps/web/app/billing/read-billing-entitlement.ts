/**
 * La fila de entitlements CRUDA para las superficies de billing (#1165):
 * /premium necesita más que el plan derivado — las referencias del MoR para el
 * portal y el estado de la suscripción para el copy honesto. Mismo carácter
 * fail-closed que `read-effective-plan.ts`: sin control plane o con un read
 * roto, la fila es null y la página trata al workspace como free.
 */

import type { StoreTarget } from "@web/store-resolver";
import type { EntitlementDirectory, WorkspaceEntitlement } from "@worthline/db";

import { withBillingControlPlaneStore } from "./billing-control-plane";

export async function readBillingEntitlement(
  target: StoreTarget,
): Promise<WorkspaceEntitlement | null> {
  if (target.kind !== "authenticated") {
    return null;
  }
  if (!process.env["WORTHLINE_CONTROL_PLANE_DB_URL"]) {
    return null;
  }
  try {
    return await withBillingControlPlaneStore(
      (store: Pick<EntitlementDirectory, "readWorkspaceEntitlement">) =>
        store.readWorkspaceEntitlement(target.workspaceId),
    );
  } catch (error) {
    console.warn(
      `billing: no se pudo leer la fila de entitlements del workspace ${target.workspaceId}`,
      error,
    );
    return null;
  }
}
