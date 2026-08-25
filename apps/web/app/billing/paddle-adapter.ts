/**
 * El adapter real de Paddle (PRD #1160 S6, #1166): traduce el checkout, el
 * webhook, la API de suscripciones y el portal de Paddle Billing a la interfaz
 * {@link BillingAdapter} de S5 (#1165). NADA más del contrato cambia — la ruta
 * de webhook, la idempotencia record-first, las transiciones puras
 * (`applyBillingEvent`), el re-sync de /admin y la página `/premium` ya son
 * agnósticos de proveedor; este fichero solo enchufa aquí (#1137 confirmó
 * Paddle como MoR ganador).
 *
 * Cero UI de facturación propia: `checkoutUrl` crea una transacción con el
 * workspace en la custom data y devuelve la URL del checkout hospedado de
 * Paddle; `portalUrl` acuña una sesión del portal del cliente. Ambas degradan a
 * null ante un fallo de la API para que `/premium` no reviente (la página ya
 * promete fail-soft).
 *
 * El destino del enlace es el **Hosted Checkout** de Paddle (#1221): la página
 * de pago que Paddle aloja, a la que se le pasa la transacción ya creada por
 * `?transaction_id=`. Se eligió frente a montar Paddle.js en una página propia
 * porque preserva el «cero UI de facturación propia» del contrato y no obliga a
 * abrir la CSP a scripts/iframes de terceros (#1256). Ojo con la trampa: la
 * `checkout.url` que devuelve la API NO es una página de Paddle, es el *default
 * payment link* de la cuenta (una página TUYA con Paddle.js) con `_ptxn`
 * añadido — sirve de fallback cuando esa página existe, nada más.
 */

import { Environment, Paddle } from "@paddle/paddle-node-sdk";
import type { BillingEvent, BillingSubscriptionState } from "@worthline/db";

import type { BillingAdapter, BillingTier, CheckoutInput } from "./adapter";

/** Header de firma de Paddle sobre el cuerpo crudo del webhook. */
export const PADDLE_SIGNATURE_HEADER = "paddle-signature";

/** El identificador que la fila guarda en `billing_provider` (re-sync lo compara). */
export const PADDLE_BILLING_PROVIDER = "paddle";

export interface PaddleBillingAdapterOptions {
  /** API key de servidor (transacciones, suscripciones, portal). */
  apiKey: string;
  /** Secreto del destino de notificaciones — verifica la firma del webhook. */
  webhookSecret: string;
  /** Entorno de Paddle; sandbox durante la beta (#1133). */
  environment: Environment;
  /**
   * URL del Hosted Checkout de Paddle (`https://pay.paddle.io/checkout/hsc_…`,
   * se crea en Paddle → Checkout → Hosted checkouts). Cuando está configurada,
   * el enlace de compra es esa URL con `?transaction_id=` de la transacción
   * recién creada. Sin ella se cae al `checkout.url` de la API — que solo abre
   * un checkout si la cuenta tiene un default payment link con Paddle.js.
   */
  hostedCheckoutUrl?: string | null;
  /**
   * Price id por tier (#1126). Un tier sin price id configurado NO se ofrece
   * en el checkout: así se despublica el lifetime cuando se agota el cupo (#50)
   * sin tocar código — basta con vaciar su variable de entorno.
   */
  priceIds: Partial<Record<BillingTier, string | undefined>>;
}

/**
 * El enlace al Hosted Checkout para una transacción ya creada: la URL
 * configurada con `transaction_id` añadido (preservando su query existente,
 * p. ej. `?theme=light`). Null si la URL configurada no es parseable — mejor
 * «el pago no está disponible» que un enlace roto.
 */
function hostedCheckoutLink(base: string, transactionId: string): string | null {
  try {
    const url = new URL(base);
    url.searchParams.set("transaction_id", transactionId);
    return url.toString();
  } catch {
    console.error(`billing(paddle): hosted checkout url no parseable "${base}"`);
    return null;
  }
}

/** Los campos comunes a todo evento del contrato, ya extraídos del payload. */
type EventBase = {
  eventId: string;
  provider: string;
  workspaceId: string;
  occurredAt: string;
  customerId: string | null;
};

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

/** El fin del periodo pagado en curso del payload de suscripción, si lo trae. */
function periodEnd(data: Record<string, unknown>): string | null {
  return asString(asRecord(data["current_billing_period"])?.["ends_at"]);
}

/**
 * Cualquier evento de suscripción de Paddle (created/activated/updated/canceled)
 * → los eventos del contrato, ROUTEADO POR EL ESTADO ACTUAL, no por el nombre
 * del evento: así el mapeo es convergente e idempotente frente a redeliveries y
 * reordenamientos. `deriveEffectivePlan` gobierna el acceso sobre las fechas, y
 * `applyBillingEvent` mantiene la ventana monótona (#1166), así que un estado
 * `active` stale nunca regresa el acceso.
 */
function mapSubscriptionEvent(
  base: EventBase,
  data: Record<string, unknown>,
): BillingEvent | null {
  const subscriptionId = asString(data["id"]);
  if (!subscriptionId) return null;
  const status = asString(data["status"]);
  const ends = periodEnd(data);

  if (status === "active" || status === "trialing") {
    // El contrato exige el fin del periodo pagado en la activación; sin él,
    // ignoramos el evento (el re-sync de /admin lo reconstruiría).
    return ends
      ? { ...base, type: "subscription_activated", subscriptionId, paidUntil: ends }
      : null;
  }
  if (status === "past_due") {
    return { ...base, type: "payment_failed", subscriptionId };
  }
  if (status === "paused" || status === "canceled") {
    // Pausa y cancelación cierran el acceso al fin de lo ya pagado.
    return { ...base, type: "subscription_canceled", subscriptionId, paidUntil: ends };
  }
  // Un estado de suscripción que Paddle añada en el futuro se ignora (200, sin
  // reintento) — el re-sync de /admin lo cubriría —, pero dejamos rastro para
  // que no sea un punto ciego silencioso.
  console.warn(
    `billing(paddle): estado de suscripción no reconocido "${status}" en ${subscriptionId}`,
  );
  return null;
}

function mapLifetimeTransaction(
  base: EventBase,
  data: Record<string, unknown>,
  lifetimePriceId: string | undefined,
): BillingEvent | null {
  // Un pago de suscripción también emite transaction.completed — lo poseen los
  // eventos de suscripción; aquí solo nos interesa la compra one-time.
  if (asString(data["subscription_id"])) return null;
  if (!lifetimePriceId) return null;

  const items = Array.isArray(data["items"]) ? data["items"] : [];
  const isLifetime = items.some((item) => {
    const priceId = asString(asRecord(asRecord(item)?.["price"])?.["id"]);
    return priceId === lifetimePriceId;
  });
  if (!isLifetime) return null;

  return { ...base, type: "lifetime_purchased" };
}

export function createPaddleBillingAdapter(
  options: PaddleBillingAdapterOptions,
): BillingAdapter {
  const paddle = new Paddle(options.apiKey, { environment: options.environment });

  return {
    provider: PADDLE_BILLING_PROVIDER,

    async checkoutUrl({ workspaceId, tier }: CheckoutInput) {
      const priceId = options.priceIds[tier];
      if (!priceId) return null;
      try {
        // El workspace viaja en la custom data (#1135): Paddle la propaga a la
        // transacción, la suscripción resultante y sus webhooks.
        const transaction = await paddle.transactions.create({
          items: [{ priceId, quantity: 1 }],
          customData: { workspaceId },
        });
        // El Hosted Checkout manda cuando está configurado; el `checkout.url`
        // de la API es el fallback para cuentas con página propia de pago.
        if (options.hostedCheckoutUrl && transaction.id) {
          return hostedCheckoutLink(options.hostedCheckoutUrl, transaction.id);
        }
        return transaction.checkout?.url ?? null;
      } catch (error) {
        console.error(
          `billing(paddle): checkout ${tier} para ${workspaceId} falló`,
          error,
        );
        return null;
      }
    },

    async portalUrl(customerId: string | null) {
      if (!customerId) return null;
      try {
        const session = await paddle.customerPortalSessions.create(customerId, []);
        return session.urls.general.overview ?? null;
      } catch (error) {
        console.error(`billing(paddle): portal para ${customerId} falló`, error);
        return null;
      }
    },

    async verifyWebhook(rawBody: string, headers: Headers) {
      const signature = headers.get(PADDLE_SIGNATURE_HEADER);
      if (!signature) return false;
      try {
        // Verifica el HMAC sobre el cuerpo crudo Y la frescura del timestamp.
        return await paddle.webhooks.isSignatureValid(
          rawBody,
          options.webhookSecret,
          signature,
        );
      } catch {
        return false;
      }
    },

    parseWebhookEvent(rawBody: string) {
      let payload: unknown;
      try {
        payload = JSON.parse(rawBody);
      } catch {
        return null;
      }
      const record = asRecord(payload);
      if (!record) return null;

      const eventType = asString(record["event_type"]);
      const eventId = asString(record["event_id"]);
      const occurredAt = asString(record["occurred_at"]);
      const data = asRecord(record["data"]);
      if (!eventType || !eventId || !occurredAt || !data) return null;

      // El workspace viaja en la custom data que fijamos en el checkout (#1135);
      // sin él no hay a quién aplicar el evento.
      const workspaceId = asString(asRecord(data["custom_data"])?.["workspaceId"]);
      if (!workspaceId) return null;

      const base: EventBase = {
        eventId,
        provider: PADDLE_BILLING_PROVIDER,
        workspaceId,
        occurredAt,
        customerId: asString(data["customer_id"]),
      };

      if (eventType.startsWith("subscription.")) {
        return mapSubscriptionEvent(base, data);
      }
      if (eventType === "transaction.completed") {
        return mapLifetimeTransaction(base, data, options.priceIds.lifetime);
      }
      // Cualquier evento fuera del contrato: la ruta lo confirma con 200 y lo
      // ignora, para que Paddle no lo reintente.
      return null;
    },

    async readSubscription(
      subscriptionId: string,
    ): Promise<BillingSubscriptionState | null> {
      try {
        const subscription = await paddle.subscriptions.get(subscriptionId);
        const status =
          subscription.status === "active" || subscription.status === "trialing"
            ? "active"
            : subscription.status === "past_due"
              ? "past_due"
              : "canceled";
        return {
          status,
          customerId: subscription.customerId ?? null,
          paidUntil: subscription.currentBillingPeriod?.endsAt ?? null,
        };
      } catch (error) {
        console.error(`billing(paddle): readSubscription ${subscriptionId} falló`, error);
        return null;
      }
    },
  };
}
