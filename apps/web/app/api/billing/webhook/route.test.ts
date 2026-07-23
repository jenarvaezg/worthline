/**
 * La ruta HTTP del webhook (PRD #1160 S5, #1165): firma → parse → delegar.
 * Las transiciones y la idempotencia se prueban end-to-end contra el store
 * real en `process-billing-event.test.ts`; aquí solo la corteza HTTP.
 */

import { createFakeBillingAdapter, signFakeWebhook } from "@web/billing/fake-adapter";
import { beforeEach, describe, expect, it, vi } from "vitest";

const getBillingAdapter = vi.fn();
vi.mock("@web/billing/get-billing-adapter", () => ({
  getBillingAdapter: (...args: unknown[]) => getBillingAdapter(...args),
}));

const processBillingEvent = vi.fn();
vi.mock("@web/billing/process-billing-event", () => ({
  processBillingEvent: (...args: unknown[]) => processBillingEvent(...args),
}));

import { POST } from "./route";

const SECRET = "test-secret";
const NOW = "2026-07-23T12:00:00.000Z";

function activationBody(): string {
  return JSON.stringify({
    id: "evt-1",
    type: "subscription.activated",
    occurredAt: NOW,
    customData: { workspaceId: "ws-1" },
    customerId: "cus-1",
    subscriptionId: "sub-1",
    paidUntil: "2026-08-23T12:00:00.000Z",
  });
}

function webhookRequest(body: string, signature?: string): Request {
  return new Request("https://worthline.test/api/billing/webhook", {
    method: "POST",
    body,
    headers: signature ? { "fake-signature": signature } : {},
  });
}

beforeEach(() => {
  getBillingAdapter.mockReset();
  processBillingEvent.mockReset();
  getBillingAdapter.mockReturnValue(createFakeBillingAdapter({ secret: SECRET }));
  processBillingEvent.mockResolvedValue("applied");
});

describe("POST /api/billing/webhook", () => {
  it("sin proveedor de billing configurado responde 503 y no procesa nada", async () => {
    getBillingAdapter.mockReturnValue(null);

    const response = await POST(webhookRequest(activationBody()));

    expect(response.status).toBe(503);
    expect(processBillingEvent).not.toHaveBeenCalled();
  });

  it("una firma inválida es 401 y no procesa nada", async () => {
    const body = activationBody();

    const unsigned = await POST(webhookRequest(body));
    const badSigned = await POST(webhookRequest(body, signFakeWebhook("otro", body)));

    expect(unsigned.status).toBe(401);
    expect(badSigned.status).toBe(401);
    expect(processBillingEvent).not.toHaveBeenCalled();
  });

  it("un evento fuera del contrato se confirma con 200 sin procesar (el MoR no debe reintentar)", async () => {
    const body = JSON.stringify({ id: "evt-9", type: "refund.created", occurredAt: NOW });

    const response = await POST(webhookRequest(body, signFakeWebhook(SECRET, body)));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, outcome: "ignored" });
    expect(processBillingEvent).not.toHaveBeenCalled();
  });

  it("un evento del contrato bien firmado se normaliza y se delega con su outcome", async () => {
    processBillingEvent.mockResolvedValue("duplicate");
    const body = activationBody();

    const response = await POST(webhookRequest(body, signFakeWebhook(SECRET, body)));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, outcome: "duplicate" });
    expect(processBillingEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "subscription_activated",
        eventId: "evt-1",
        workspaceId: "ws-1",
      }),
    );
  });
});
