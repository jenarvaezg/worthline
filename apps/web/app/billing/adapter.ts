/**
 * El puerto de billing (PRD #1160 S5, #1165; contrato #1135): la interfaz fina
 * por proveedor tras la que se implementa TODO el contrato billing→entitlements
 * — checkout hospedado con el workspace id en custom data, verificación de
 * firma del webhook, normalización de eventos y consulta de estado para el
 * re-sync. S5 la implementa el adapter de pruebas (`fake-adapter.ts`); el
 * adapter real del MoR ganador (Paddle, #1137) llega en S6 y solo enchufa aquí.
 *
 * Cero UI de facturación propia: checkout y portal del cliente son URLs del
 * MoR a las que enlazamos.
 */

import type { BillingEvent, BillingSubscriptionState } from "@worthline/db";

/** Los tres carriles de compra (#1126): suscripción mensual/anual y lifetime one-time. */
export type BillingTier = "monthly" | "annual" | "lifetime";

export const BILLING_TIERS: readonly BillingTier[] = ["monthly", "annual", "lifetime"];

export function parseBillingTier(raw: unknown): BillingTier | null {
  return BILLING_TIERS.includes(raw as BillingTier) ? (raw as BillingTier) : null;
}

export interface CheckoutInput {
  /** El workspace que compra — viaja en la custom data del checkout (#1135). */
  workspaceId: string;
  tier: BillingTier;
}

export interface BillingAdapter {
  /** El identificador estable del proveedor — lo que la fila guarda en `billing_provider`. */
  readonly provider: string;
  /**
   * URL del checkout hospedado para un tier, o null cuando ese tier no está
   * configurado (p. ej. el cupo del lifetime agotado se despublica por config).
   */
  checkoutUrl(input: CheckoutInput): Promise<string | null>;
  /**
   * URL del portal del cliente del MoR (cancelar, facturas), o null cuando el
   * proveedor no la ofrece o el workspace aún no es cliente.
   */
  portalUrl(customerId: string | null): Promise<string | null>;
  /**
   * Verifica la firma del webhook sobre el cuerpo CRUDO. Debe ser constante en
   * tiempo frente al secreto; un false es un 401 en la ruta.
   */
  verifyWebhook(rawBody: string, headers: Headers): Promise<boolean>;
  /**
   * Normaliza un payload ya verificado a los cuatro eventos del contrato
   * (#1135), o null para cualquier evento fuera de él — la ruta lo confirma
   * con 200 y lo ignora, para que el MoR no lo reintente.
   */
  parseWebhookEvent(rawBody: string): BillingEvent | null;
  /**
   * Estado actual de una suscripción según la API del proveedor — el re-sync
   * manual de /admin. Null cuando el proveedor no la conoce.
   */
  readSubscription(subscriptionId: string): Promise<BillingSubscriptionState | null>;
}
