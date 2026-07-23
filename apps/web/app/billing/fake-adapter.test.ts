import { describe, expect, it } from "vitest";

import {
  createFakeBillingAdapter,
  type FakeBillingAdapterOptions,
  signFakeWebhook,
} from "./fake-adapter";

const SECRET = "test-secret";
const NOW = "2026-07-23T12:00:00.000Z";
const PERIOD_END = "2026-08-23T12:00:00.000Z";

function adapter(overrides: Partial<FakeBillingAdapterOptions> = {}) {
  return createFakeBillingAdapter({ secret: SECRET, ...overrides });
}

function activationBody(): string {
  return JSON.stringify({
    id: "evt-1",
    type: "subscription.activated",
    occurredAt: NOW,
    customData: { workspaceId: "ws-1" },
    customerId: "cus-1",
    subscriptionId: "sub-1",
    paidUntil: PERIOD_END,
  });
}

describe("fake billing adapter (PRD #1160 S5, #1165)", () => {
  it("construye la URL de checkout con el workspace id como custom data y el tier", async () => {
    const fake = adapter({
      secret: SECRET,
      checkoutBaseUrl: "https://fake.test/checkout",
    });

    const url = await fake.checkoutUrl({ workspaceId: "ws-1", tier: "monthly" });

    expect(url).not.toBeNull();
    const parsed = new URL(url!);
    expect(parsed.searchParams.get("workspace_id")).toBe("ws-1");
    expect(parsed.searchParams.get("tier")).toBe("monthly");
  });

  it("sin URL base de checkout configurada no ofrece checkout", async () => {
    expect(
      await adapter().checkoutUrl({ workspaceId: "ws-1", tier: "monthly" }),
    ).toBeNull();
  });

  it("acepta una firma HMAC válida sobre el cuerpo crudo y rechaza las demás", async () => {
    const fake = adapter();
    const body = activationBody();

    const goodHeaders = new Headers({ "fake-signature": signFakeWebhook(SECRET, body) });
    expect(await fake.verifyWebhook(body, goodHeaders)).toBe(true);

    const badHeaders = new Headers({
      "fake-signature": signFakeWebhook("otro-secreto", body),
    });
    expect(await fake.verifyWebhook(body, badHeaders)).toBe(false);
    expect(await fake.verifyWebhook(body, new Headers())).toBe(false);
    // La firma cubre el cuerpo: cambiarlo la invalida.
    expect(await fake.verifyWebhook(`${body} `, goodHeaders)).toBe(false);
  });

  it("normaliza los cuatro eventos del contrato", () => {
    const fake = adapter();

    const activated = fake.parseWebhookEvent(activationBody());
    expect(activated).toEqual({
      type: "subscription_activated",
      eventId: "evt-1",
      provider: "fake",
      workspaceId: "ws-1",
      occurredAt: NOW,
      customerId: "cus-1",
      subscriptionId: "sub-1",
      paidUntil: PERIOD_END,
    });

    const canceled = fake.parseWebhookEvent(
      JSON.stringify({
        id: "evt-2",
        type: "subscription.canceled",
        occurredAt: NOW,
        customData: { workspaceId: "ws-1" },
        customerId: null,
        subscriptionId: "sub-1",
        paidUntil: null,
      }),
    );
    expect(canceled?.type).toBe("subscription_canceled");

    const failed = fake.parseWebhookEvent(
      JSON.stringify({
        id: "evt-3",
        type: "payment.failed",
        occurredAt: NOW,
        customData: { workspaceId: "ws-1" },
        subscriptionId: "sub-1",
      }),
    );
    expect(failed?.type).toBe("payment_failed");

    const lifetime = fake.parseWebhookEvent(
      JSON.stringify({
        id: "evt-4",
        type: "lifetime.purchased",
        occurredAt: NOW,
        customData: { workspaceId: "ws-1" },
        customerId: "cus-1",
      }),
    );
    expect(lifetime?.type).toBe("lifetime_purchased");
  });

  it("devuelve null para eventos fuera del contrato o payloads inválidos", () => {
    const fake = adapter();

    expect(fake.parseWebhookEvent("not json")).toBeNull();
    expect(
      fake.parseWebhookEvent(
        JSON.stringify({ id: "evt-9", type: "refund.created", occurredAt: NOW }),
      ),
    ).toBeNull();
    // Sin workspace en la custom data no hay a quién aplicar el evento.
    expect(
      fake.parseWebhookEvent(
        JSON.stringify({ id: "evt-10", type: "payment.failed", occurredAt: NOW }),
      ),
    ).toBeNull();
    // Una activación sin fin de periodo viola el contrato del adapter.
    expect(
      fake.parseWebhookEvent(
        JSON.stringify({
          id: "evt-11",
          type: "subscription.activated",
          occurredAt: NOW,
          customData: { workspaceId: "ws-1" },
          subscriptionId: "sub-1",
        }),
      ),
    ).toBeNull();
  });

  it("sirve el estado de suscripción inyectado para el re-sync, y el portal configurado", async () => {
    const fake = adapter({
      secret: SECRET,
      portalUrl: "https://fake.test/portal",
      subscriptions: {
        "sub-1": { status: "active", customerId: "cus-1", paidUntil: PERIOD_END },
      },
    });

    expect(await fake.readSubscription("sub-1")).toEqual({
      status: "active",
      customerId: "cus-1",
      paidUntil: PERIOD_END,
    });
    expect(await fake.readSubscription("sub-desconocida")).toBeNull();
    expect(await fake.portalUrl("cus-1")).toBe("https://fake.test/portal");
  });
});
