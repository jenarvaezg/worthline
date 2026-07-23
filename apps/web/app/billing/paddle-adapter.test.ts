import { beforeEach, describe, expect, it, vi } from "vitest";

const transactionsCreate = vi.fn();
const subscriptionsGet = vi.fn();
const portalCreate = vi.fn();
const isSignatureValid = vi.fn();

vi.mock("@paddle/paddle-node-sdk", () => ({
  Environment: { sandbox: "sandbox", production: "production" },
  Paddle: class {
    transactions = { create: transactionsCreate };
    subscriptions = { get: subscriptionsGet };
    customerPortalSessions = { create: portalCreate };
    webhooks = { isSignatureValid };
  },
}));

import {
  createPaddleBillingAdapter,
  PADDLE_SIGNATURE_HEADER,
  type PaddleBillingAdapterOptions,
} from "./paddle-adapter";

const NOW = "2026-07-23T12:00:00.000Z";
const PERIOD_END = "2026-08-23T12:00:00.000Z";

const PRICE_IDS = {
  monthly: "pri_monthly",
  annual: "pri_annual",
  lifetime: "pri_lifetime",
} as const;

function adapter(overrides: Partial<PaddleBillingAdapterOptions> = {}) {
  return createPaddleBillingAdapter({
    apiKey: "pdl_sdbx_apikey_test",
    webhookSecret: "pdl_ntfset_secret",
    environment: "sandbox" as never,
    priceIds: PRICE_IDS,
    ...overrides,
  });
}

/** Un payload de webhook de suscripción de Paddle (wire format snake_case). */
function subscriptionBody(eventType: string, data: Record<string, unknown>): string {
  return JSON.stringify({
    event_id: "evt-1",
    event_type: eventType,
    occurred_at: NOW,
    data: {
      id: "sub-1",
      customer_id: "ctm-1",
      custom_data: { workspaceId: "ws-1" },
      ...data,
    },
  });
}

beforeEach(() => {
  transactionsCreate.mockReset();
  subscriptionsGet.mockReset();
  portalCreate.mockReset();
  isSignatureValid.mockReset();
});

describe("paddle billing adapter — checkout (PRD #1160 S6, #1166)", () => {
  it("crea una transacción con el workspace en la custom data y devuelve la URL hospedada", async () => {
    transactionsCreate.mockResolvedValue({
      checkout: { url: "https://pay.paddle.com/abc" },
    });

    const url = await adapter().checkoutUrl({ workspaceId: "ws-1", tier: "annual" });

    expect(url).toBe("https://pay.paddle.com/abc");
    expect(transactionsCreate).toHaveBeenCalledWith({
      items: [{ priceId: "pri_annual", quantity: 1 }],
      customData: { workspaceId: "ws-1" },
    });
  });

  it("un tier sin price id configurado no se ofrece (cupo lifetime agotado)", async () => {
    const url = await adapter({ priceIds: { monthly: "pri_monthly" } }).checkoutUrl({
      workspaceId: "ws-1",
      tier: "lifetime",
    });

    expect(url).toBeNull();
    expect(transactionsCreate).not.toHaveBeenCalled();
  });

  it("degrada a null si la API de Paddle falla (fail-soft de /premium)", async () => {
    transactionsCreate.mockRejectedValue(new Error("paddle down"));

    expect(
      await adapter().checkoutUrl({ workspaceId: "ws-1", tier: "monthly" }),
    ).toBeNull();
  });
});

describe("paddle billing adapter — portal", () => {
  it("acuña una sesión del portal y devuelve la URL de resumen", async () => {
    portalCreate.mockResolvedValue({
      urls: { general: { overview: "https://portal.paddle.com/x" } },
    });

    expect(await adapter().portalUrl("ctm-1")).toBe("https://portal.paddle.com/x");
    expect(portalCreate).toHaveBeenCalledWith("ctm-1", []);
  });

  it("sin customer id no hay portal", async () => {
    expect(await adapter().portalUrl(null)).toBeNull();
    expect(portalCreate).not.toHaveBeenCalled();
  });

  it("degrada a null si la API falla", async () => {
    portalCreate.mockRejectedValue(new Error("nope"));
    expect(await adapter().portalUrl("ctm-1")).toBeNull();
  });
});

describe("paddle billing adapter — verificación de firma", () => {
  it("delega en isSignatureValid del SDK sobre el cuerpo crudo", async () => {
    isSignatureValid.mockResolvedValue(true);
    const headers = new Headers({ [PADDLE_SIGNATURE_HEADER]: "ts=1;h1=abc" });

    expect(await adapter().verifyWebhook("raw", headers)).toBe(true);
    expect(isSignatureValid).toHaveBeenCalledWith(
      "raw",
      "pdl_ntfset_secret",
      "ts=1;h1=abc",
    );
  });

  it("sin header de firma rechaza sin llamar al SDK", async () => {
    expect(await adapter().verifyWebhook("raw", new Headers())).toBe(false);
    expect(isSignatureValid).not.toHaveBeenCalled();
  });

  it("una firma inválida que el SDK resuelve como false es un rechazo", async () => {
    isSignatureValid.mockResolvedValue(false);
    const headers = new Headers({ [PADDLE_SIGNATURE_HEADER]: "ts=1;h1=malo" });
    expect(await adapter().verifyWebhook("raw", headers)).toBe(false);
  });

  it("una firma que hace lanzar al SDK es un rechazo", async () => {
    isSignatureValid.mockRejectedValue(new Error("bad signature"));
    const headers = new Headers({ [PADDLE_SIGNATURE_HEADER]: "malo" });
    expect(await adapter().verifyWebhook("raw", headers)).toBe(false);
  });
});

describe("paddle billing adapter — normalización de webhooks", () => {
  it("suscripción activa → subscription_activated con el fin del periodo pagado", () => {
    const event = adapter().parseWebhookEvent(
      subscriptionBody("subscription.activated", {
        status: "active",
        current_billing_period: { starts_at: NOW, ends_at: PERIOD_END },
      }),
    );

    expect(event).toEqual({
      type: "subscription_activated",
      eventId: "evt-1",
      provider: "paddle",
      workspaceId: "ws-1",
      occurredAt: NOW,
      customerId: "ctm-1",
      subscriptionId: "sub-1",
      paidUntil: PERIOD_END,
    });
  });

  it("una renovación llega como subscription.updated activa y también activa la ventana", () => {
    const event = adapter().parseWebhookEvent(
      subscriptionBody("subscription.updated", {
        status: "active",
        current_billing_period: { starts_at: NOW, ends_at: PERIOD_END },
      }),
    );
    expect(event?.type).toBe("subscription_activated");
  });

  it("estado past_due → payment_failed", () => {
    const event = adapter().parseWebhookEvent(
      subscriptionBody("subscription.updated", { status: "past_due" }),
    );
    expect(event?.type).toBe("payment_failed");
  });

  it("cancelada y pausada → subscription_canceled hasta el fin de lo pagado", () => {
    const canceled = adapter().parseWebhookEvent(
      subscriptionBody("subscription.canceled", {
        status: "canceled",
        current_billing_period: { starts_at: NOW, ends_at: PERIOD_END },
      }),
    );
    expect(canceled).toMatchObject({
      type: "subscription_canceled",
      paidUntil: PERIOD_END,
    });

    const paused = adapter().parseWebhookEvent(
      subscriptionBody("subscription.updated", { status: "paused" }),
    );
    expect(paused).toMatchObject({ type: "subscription_canceled", paidUntil: null });
  });

  it("una activación sin fin de periodo se ignora (viola el contrato del adapter)", () => {
    const event = adapter().parseWebhookEvent(
      subscriptionBody("subscription.activated", { status: "active" }),
    );
    expect(event).toBeNull();
  });

  it("transaction.completed one-time del price lifetime → lifetime_purchased", () => {
    const event = adapter().parseWebhookEvent(
      JSON.stringify({
        event_id: "evt-2",
        event_type: "transaction.completed",
        occurred_at: NOW,
        data: {
          id: "txn-1",
          customer_id: "ctm-1",
          subscription_id: null,
          custom_data: { workspaceId: "ws-1" },
          items: [{ price: { id: "pri_lifetime", product_id: "pro-1" } }],
        },
      }),
    );
    expect(event).toMatchObject({
      type: "lifetime_purchased",
      workspaceId: "ws-1",
      customerId: "ctm-1",
    });
  });

  it("transaction.completed de un pago de suscripción se ignora (lo poseen los eventos de suscripción)", () => {
    const event = adapter().parseWebhookEvent(
      JSON.stringify({
        event_id: "evt-3",
        event_type: "transaction.completed",
        occurred_at: NOW,
        data: {
          id: "txn-2",
          subscription_id: "sub-1",
          custom_data: { workspaceId: "ws-1" },
          items: [{ price: { id: "pri_monthly" } }],
        },
      }),
    );
    expect(event).toBeNull();
  });

  it("transaction.completed one-time de un price desconocido se ignora", () => {
    const event = adapter().parseWebhookEvent(
      JSON.stringify({
        event_id: "evt-4",
        event_type: "transaction.completed",
        occurred_at: NOW,
        data: {
          id: "txn-3",
          subscription_id: null,
          custom_data: { workspaceId: "ws-1" },
          items: [{ price: { id: "pri_otra_cosa" } }],
        },
      }),
    );
    expect(event).toBeNull();
  });

  it("devuelve null para JSON inválido, eventos fuera del contrato y sin workspace", () => {
    const a = adapter();
    expect(a.parseWebhookEvent("not json")).toBeNull();
    expect(
      a.parseWebhookEvent(
        JSON.stringify({
          event_id: "e",
          event_type: "payout.paid",
          occurred_at: NOW,
          data: {},
        }),
      ),
    ).toBeNull();
    // Sin workspace en la custom data no hay a quién aplicar el evento.
    expect(
      a.parseWebhookEvent(
        JSON.stringify({
          event_id: "e",
          event_type: "subscription.activated",
          occurred_at: NOW,
          data: {
            id: "sub-1",
            status: "active",
            current_billing_period: { ends_at: PERIOD_END },
          },
        }),
      ),
    ).toBeNull();
  });
});

describe("paddle billing adapter — readSubscription (re-sync /admin)", () => {
  it("mapea active/trialing → active con el fin de periodo y el cliente", async () => {
    subscriptionsGet.mockResolvedValue({
      status: "active",
      customerId: "ctm-1",
      currentBillingPeriod: { startsAt: NOW, endsAt: PERIOD_END },
    });

    expect(await adapter().readSubscription("sub-1")).toEqual({
      status: "active",
      customerId: "ctm-1",
      paidUntil: PERIOD_END,
    });
  });

  it("mapea past_due tal cual y paused/canceled → canceled", async () => {
    subscriptionsGet.mockResolvedValue({
      status: "past_due",
      customerId: null,
      currentBillingPeriod: null,
    });
    expect((await adapter().readSubscription("sub-1"))?.status).toBe("past_due");

    subscriptionsGet.mockResolvedValue({
      status: "paused",
      customerId: null,
      currentBillingPeriod: null,
    });
    expect((await adapter().readSubscription("sub-1"))?.status).toBe("canceled");
  });

  it("una suscripción que la API no conoce (lanza) devuelve null", async () => {
    subscriptionsGet.mockRejectedValue(new Error("404"));
    expect(await adapter().readSubscription("sub-desconocida")).toBeNull();
  });
});
