/**
 * El adapter de pruebas del contrato de billing (PRD #1160 S5, #1165): un
 * proveedor `fake` completo — firma HMAC sobre el cuerpo crudo, eventos
 * normalizables, checkout/portal por configuración y estados de suscripción
 * inyectables — para que la ruta de webhook, las transiciones y el re-sync se
 * prueben end-to-end SIN el MoR real. El adapter de Paddle (S6, #1166)
 * sustituye a este tras la misma interfaz; nada más cambia.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

import type { BillingEvent, BillingSubscriptionState } from "@worthline/db";

import type { BillingAdapter, CheckoutInput } from "./adapter";

/** Header de firma del proveedor fake — HMAC-SHA256 hex del cuerpo crudo. */
export const FAKE_SIGNATURE_HEADER = "fake-signature";

export const FAKE_BILLING_PROVIDER = "fake";

/** Firma un cuerpo como lo haría el proveedor fake — para tests y simulaciones. */
export function signFakeWebhook(secret: string, rawBody: string): string {
  return createHmac("sha256", secret).update(rawBody).digest("hex");
}

export interface FakeBillingAdapterOptions {
  /** El secreto compartido del webhook (equivale al endpoint secret del MoR). */
  secret: string;
  /** Base del checkout hospedado simulado; sin ella no se ofrece checkout. */
  checkoutBaseUrl?: string | null;
  /** URL del portal del cliente simulado, si se ofrece. */
  portalUrl?: string | null;
  /** Estados de suscripción que `readSubscription` sirve — la "API" del fake. */
  subscriptions?: Record<string, BillingSubscriptionState>;
}

/** El wire format del proveedor fake: el workspace viaja en `customData` (#1135). */
const EVENT_TYPES: Record<string, BillingEvent["type"]> = {
  "subscription.activated": "subscription_activated",
  "subscription.canceled": "subscription_canceled",
  "payment.failed": "payment_failed",
  "lifetime.purchased": "lifetime_purchased",
};

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function parseFakePayload(rawBody: string): BillingEvent | null {
  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return null;
  }
  if (typeof payload !== "object" || payload === null) return null;
  const record = payload as Record<string, unknown>;

  const type = EVENT_TYPES[String(record["type"])];
  const eventId = asString(record["id"]);
  const occurredAt = asString(record["occurredAt"]);
  const customData = record["customData"];
  const workspaceId =
    typeof customData === "object" && customData !== null
      ? asString((customData as Record<string, unknown>)["workspaceId"])
      : null;
  if (!type || !eventId || !occurredAt || !workspaceId) return null;

  const base = {
    eventId,
    provider: FAKE_BILLING_PROVIDER,
    workspaceId,
    occurredAt,
    customerId: asString(record["customerId"]),
  };

  if (type === "lifetime_purchased") {
    return { ...base, type };
  }

  const subscriptionId = asString(record["subscriptionId"]);
  if (!subscriptionId) return null;

  if (type === "subscription_activated") {
    // El contrato del adapter exige el fin del periodo pagado en la activación.
    const paidUntil = asString(record["paidUntil"]);
    return paidUntil ? { ...base, type, subscriptionId, paidUntil } : null;
  }
  if (type === "subscription_canceled") {
    return { ...base, type, subscriptionId, paidUntil: asString(record["paidUntil"]) };
  }
  return { ...base, type, subscriptionId };
}

export function createFakeBillingAdapter(
  options: FakeBillingAdapterOptions,
): BillingAdapter {
  return {
    provider: FAKE_BILLING_PROVIDER,
    async checkoutUrl({ workspaceId, tier }: CheckoutInput) {
      if (!options.checkoutBaseUrl) return null;
      // Una base malformada (config del operador) degrada a "sin checkout" en
      // vez de tumbar el render de /premium — la página ya promete fail-soft.
      let url: URL;
      try {
        url = new URL(options.checkoutBaseUrl);
      } catch {
        return null;
      }
      url.searchParams.set("tier", tier);
      url.searchParams.set("workspace_id", workspaceId);
      return url.toString();
    },
    async portalUrl() {
      return options.portalUrl ?? null;
    },
    async verifyWebhook(rawBody, headers) {
      const given = headers.get(FAKE_SIGNATURE_HEADER);
      if (!given) return false;
      const expected = signFakeWebhook(options.secret, rawBody);
      const givenBuffer = Buffer.from(given);
      const expectedBuffer = Buffer.from(expected);
      return (
        givenBuffer.length === expectedBuffer.length &&
        timingSafeEqual(givenBuffer, expectedBuffer)
      );
    },
    parseWebhookEvent(rawBody) {
      return parseFakePayload(rawBody);
    },
    async readSubscription(subscriptionId) {
      return options.subscriptions?.[subscriptionId] ?? null;
    },
  };
}
