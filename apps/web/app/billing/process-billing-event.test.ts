/**
 * El contrato billing→entitlements end-to-end (PRD #1160 S5, #1165) sobre el
 * store REAL in-memory: evento normalizado → idempotencia → transición → fila.
 * La ruta HTTP por encima solo verifica firma y parsea (route.test.ts).
 */

import {
  type BillingEvent,
  createInMemoryControlPlaneStore,
  deriveEffectivePlan,
  PAYMENT_GRACE_DAYS,
} from "@worthline/db";
import { describe, expect, it } from "vitest";

import { type BillingProcessStore, processBillingEvent } from "./process-billing-event";

const NOW = "2026-07-23T12:00:00.000Z";
const PERIOD_END = "2026-08-23T12:00:00.000Z";
const AFTER_PERIOD = "2026-08-24T00:00:00.000Z";
const DAY_MS = 24 * 60 * 60 * 1000;

async function storeWithWorkspace(): Promise<{
  store: BillingProcessStore & { close(): void };
  workspaceId: string;
}> {
  const store = await createInMemoryControlPlaneStore();
  const workspace = await store.createWorkspace({
    dbName: "wl-billing-e2e",
    dbUrl: "file:wl-billing-e2e.sqlite",
  });
  return { store, workspaceId: workspace.id };
}

function activation(workspaceId: string, eventId = "evt-1"): BillingEvent {
  return {
    type: "subscription_activated",
    eventId,
    provider: "fake",
    workspaceId,
    occurredAt: NOW,
    customerId: "cus-1",
    subscriptionId: "sub-1",
    paidUntil: PERIOD_END,
  };
}

describe("processBillingEvent (contrato #1135 end-to-end)", () => {
  it("alta: el webhook deja el workspace en premium hasta el fin de periodo, con refs del MoR", async () => {
    const { store, workspaceId } = await storeWithWorkspace();

    const outcome = await processBillingEvent(activation(workspaceId), store);

    expect(outcome).toBe("applied");
    const row = await store.readWorkspaceEntitlement(workspaceId);
    expect(deriveEffectivePlan(row, NOW)).toBe("premium");
    expect(deriveEffectivePlan(row, AFTER_PERIOD)).toBe("free");
    expect(row!.billingProvider).toBe("fake");
    expect(row!.subscriptionId).toBe("sub-1");
    expect(row!.subscriptionStatus).toBe("active");
    store.close();
  });

  it("idempotencia: la redelivery del mismo event id no se re-aplica", async () => {
    const { store, workspaceId } = await storeWithWorkspace();

    await processBillingEvent(activation(workspaceId), store);
    // Entre medias llega la cancelación…
    await processBillingEvent(
      {
        type: "subscription_canceled",
        eventId: "evt-2",
        provider: "fake",
        workspaceId,
        occurredAt: NOW,
        customerId: "cus-1",
        subscriptionId: "sub-1",
        paidUntil: PERIOD_END,
      },
      store,
    );
    // …y el MoR reintenta la alta original: se detecta y NO pisa la cancelación.
    const retried = await processBillingEvent(activation(workspaceId), store);

    expect(retried).toBe("duplicate");
    const row = await store.readWorkspaceEntitlement(workspaceId);
    expect(row!.subscriptionStatus).toBe("canceled");
    store.close();
  });

  it("cancelación: premium hasta el fin de lo pagado y free después, sin perder datos", async () => {
    const { store, workspaceId } = await storeWithWorkspace();
    await processBillingEvent(activation(workspaceId), store);

    const outcome = await processBillingEvent(
      {
        type: "subscription_canceled",
        eventId: "evt-2",
        provider: "fake",
        workspaceId,
        occurredAt: NOW,
        customerId: "cus-1",
        subscriptionId: "sub-1",
        paidUntil: PERIOD_END,
      },
      store,
    );

    expect(outcome).toBe("applied");
    const row = await store.readWorkspaceEntitlement(workspaceId);
    expect(row!.subscriptionStatus).toBe("canceled");
    expect(deriveEffectivePlan(row, NOW)).toBe("premium");
    expect(deriveEffectivePlan(row, AFTER_PERIOD)).toBe("free");
    store.close();
  });

  it("impago: gracia corta y luego free", async () => {
    const { store, workspaceId } = await storeWithWorkspace();

    await processBillingEvent(
      {
        type: "payment_failed",
        eventId: "evt-3",
        provider: "fake",
        workspaceId,
        occurredAt: NOW,
        customerId: "cus-1",
        subscriptionId: "sub-1",
      },
      store,
    );

    const row = await store.readWorkspaceEntitlement(workspaceId);
    const afterGrace = new Date(
      Date.parse(NOW) + (PAYMENT_GRACE_DAYS + 1) * DAY_MS,
    ).toISOString();
    expect(row!.subscriptionStatus).toBe("past_due");
    expect(deriveEffectivePlan(row, NOW)).toBe("premium");
    expect(deriveEffectivePlan(row, afterGrace)).toBe("free");
    store.close();
  });

  it("lifetime one-time: grant indefinido por el carril del grant manual", async () => {
    const { store, workspaceId } = await storeWithWorkspace();

    await processBillingEvent(
      {
        type: "lifetime_purchased",
        eventId: "evt-4",
        provider: "fake",
        workspaceId,
        occurredAt: NOW,
        customerId: "cus-1",
      },
      store,
    );

    const row = await store.readWorkspaceEntitlement(workspaceId);
    expect(row!.plan).toBe("premium");
    expect(row!.premiumUntil).toBeNull();
    expect(deriveEffectivePlan(row, "2036-01-01T00:00:00.000Z")).toBe("premium");
    store.close();
  });

  it("un workspace desconocido en la custom data se confirma sin aplicar nada", async () => {
    const { store } = await storeWithWorkspace();

    const outcome = await processBillingEvent(activation("ws-inexistente"), store);

    expect(outcome).toBe("unknown_workspace");
    expect(await store.readWorkspaceEntitlement("ws-inexistente")).toBeNull();
    store.close();
  });
});
