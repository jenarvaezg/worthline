/**
 * El corazón de la ruta de webhook (PRD #1160 S5, #1165): evento ya verificado
 * y normalizado → idempotencia por event id → transición pura → fila de
 * entitlements. Separado de la ruta HTTP para que el contrato entero se pruebe
 * contra el store real in-memory sin servidor.
 */

import {
  applyBillingEvent,
  type BillingEvent,
  type EntitlementDirectory,
  type TenancyDirectory,
} from "@worthline/db";

import { withBillingControlPlaneStore } from "./billing-control-plane";

export type BillingEventOutcome = "applied" | "duplicate" | "unknown_workspace";

export type BillingProcessStore = Pick<
  EntitlementDirectory,
  "readWorkspaceEntitlement" | "recordBillingWebhookEvent" | "updateWorkspaceBilling"
> &
  Pick<TenancyDirectory, "getWorkspaceWithOwner">;

/**
 * Aplica un evento de billing sobre el control plane. El registro de
 * idempotencia va PRIMERO: una redelivery del MoR (o una entrega concurrente)
 * pierde el insert y se confirma sin re-aplicar, así un reintento tardío jamás
 * pisa un evento más nuevo ya aplicado. La ventana de fallo entre registrar y
 * aplicar la cubre la red de seguridad del slice: el re-sync manual de /admin.
 *
 * Un workspace desconocido en la custom data no es transitorio (la custom data
 * se fija en el checkout), así que se confirma como procesado — reintentarlo no
 * lo arreglaría — y se deja rastro en el log del servidor.
 */
export async function processBillingEvent(
  event: BillingEvent,
  injectedStore?: BillingProcessStore,
): Promise<BillingEventOutcome> {
  return withBillingControlPlaneStore(async (store: BillingProcessStore) => {
    const fresh = await store.recordBillingWebhookEvent(event.provider, event.eventId);
    if (!fresh) {
      return "duplicate";
    }

    const workspace = await store.getWorkspaceWithOwner(event.workspaceId);
    if (!workspace) {
      console.warn(
        `billing: el evento ${event.eventId} (${event.type}) trae un workspace desconocido ${event.workspaceId}; se confirma sin aplicar`,
      );
      return "unknown_workspace";
    }

    const current = await store.readWorkspaceEntitlement(event.workspaceId);
    await store.updateWorkspaceBilling({
      workspaceId: event.workspaceId,
      ...applyBillingEvent(current, event),
    });
    return "applied";
  }, injectedStore);
}
