import { describe, expect, it } from "vitest";

import {
  applyBillingEvent,
  type BillingEvent,
  billingStateFromSubscription,
  PAYMENT_GRACE_DAYS,
} from "./billing";
import { deriveEffectivePlan, type WorkspaceEntitlement } from "./entitlements";

const NOW = "2026-07-23T12:00:00.000Z";
const PERIOD_END = "2026-08-23T12:00:00.000Z";
const DAY_MS = 24 * 60 * 60 * 1000;

function entitlementRow(
  overrides: Partial<WorkspaceEntitlement> = {},
): WorkspaceEntitlement {
  return {
    workspaceId: "ws-1",
    plan: "free",
    trialEndsAt: null,
    premiumUntil: null,
    billingProvider: null,
    billingCustomerId: null,
    subscriptionId: null,
    subscriptionStatus: null,
    onboardedAt: null,
    firstHoldingAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function activation(overrides: Partial<BillingEvent> = {}): BillingEvent {
  return {
    type: "subscription_activated",
    eventId: "evt-1",
    provider: "fake",
    workspaceId: "ws-1",
    occurredAt: NOW,
    customerId: "cus-1",
    subscriptionId: "sub-1",
    paidUntil: PERIOD_END,
    ...overrides,
  } as BillingEvent;
}

describe("applyBillingEvent (PRD #1160 S5, contrato #1135)", () => {
  it("alta: un workspace sin fila pasa a premium hasta el fin del periodo pagado", () => {
    const state = applyBillingEvent(null, activation());

    expect(state).toEqual({
      premiumUntil: PERIOD_END,
      billingProvider: "fake",
      billingCustomerId: "cus-1",
      subscriptionId: "sub-1",
      subscriptionStatus: "active",
    });
    expect(
      deriveEffectivePlan({ plan: "premium", ...state, trialEndsAt: null }, NOW),
    ).toBe("premium");
  });

  it("renovación: una nueva activación mueve la ventana al nuevo fin de periodo", () => {
    const current = entitlementRow({
      plan: "premium",
      premiumUntil: NOW,
      billingProvider: "fake",
      billingCustomerId: "cus-1",
      subscriptionId: "sub-1",
      subscriptionStatus: "active",
    });
    const nextPeriodEnd = "2026-09-23T12:00:00.000Z";

    const state = applyBillingEvent(current, activation({ paidUntil: nextPeriodEnd }));

    expect(state.premiumUntil).toBe(nextPeriodEnd);
    expect(state.subscriptionStatus).toBe("active");
  });

  it("cancelación: premium se mantiene hasta el fin de periodo del evento y luego cae a free", () => {
    const current = entitlementRow({
      plan: "premium",
      premiumUntil: PERIOD_END,
      billingProvider: "fake",
      billingCustomerId: "cus-1",
      subscriptionId: "sub-1",
      subscriptionStatus: "active",
    });

    const state = applyBillingEvent(current, {
      type: "subscription_canceled",
      eventId: "evt-2",
      provider: "fake",
      workspaceId: "ws-1",
      occurredAt: NOW,
      customerId: "cus-1",
      subscriptionId: "sub-1",
      paidUntil: PERIOD_END,
    });

    expect(state.subscriptionStatus).toBe("canceled");
    expect(state.premiumUntil).toBe(PERIOD_END);
    const stored = {
      plan: "premium" as const,
      premiumUntil: state.premiumUntil,
      trialEndsAt: null,
    };
    expect(deriveEffectivePlan(stored, NOW)).toBe("premium");
    expect(deriveEffectivePlan(stored, "2026-08-24T00:00:00.000Z")).toBe("free");
  });

  it("cancelación sin fin de periodo en el evento conserva la ventana ya almacenada", () => {
    const current = entitlementRow({ plan: "premium", premiumUntil: PERIOD_END });

    const state = applyBillingEvent(current, {
      type: "subscription_canceled",
      eventId: "evt-2",
      provider: "fake",
      workspaceId: "ws-1",
      occurredAt: NOW,
      customerId: null,
      subscriptionId: "sub-1",
      paidUntil: null,
    });

    expect(state.premiumUntil).toBe(PERIOD_END);
  });

  it("cancelación sin ninguna ventana conocida cierra en el instante del evento", () => {
    const state = applyBillingEvent(null, {
      type: "subscription_canceled",
      eventId: "evt-2",
      provider: "fake",
      workspaceId: "ws-1",
      occurredAt: NOW,
      customerId: null,
      subscriptionId: "sub-1",
      paidUntil: null,
    });

    expect(state.premiumUntil).toBe(NOW);
    expect(
      deriveEffectivePlan(
        { plan: "premium", premiumUntil: state.premiumUntil, trialEndsAt: null },
        NOW,
      ),
    ).toBe("free");
  });

  it("impago: abre la gracia corta desde el instante del evento", () => {
    const state = applyBillingEvent(null, {
      type: "payment_failed",
      eventId: "evt-3",
      provider: "fake",
      workspaceId: "ws-1",
      occurredAt: NOW,
      customerId: "cus-1",
      subscriptionId: "sub-1",
    });

    const graceEnd = new Date(
      Date.parse(NOW) + PAYMENT_GRACE_DAYS * DAY_MS,
    ).toISOString();
    expect(state.premiumUntil).toBe(graceEnd);
    expect(state.subscriptionStatus).toBe("past_due");
    const stored = {
      plan: "premium" as const,
      premiumUntil: state.premiumUntil,
      trialEndsAt: null,
    };
    expect(deriveEffectivePlan(stored, NOW)).toBe("premium");
    expect(deriveEffectivePlan(stored, graceEnd)).toBe("free");
  });

  it("impago nunca acorta un periodo ya pagado más largo que la gracia", () => {
    const paidFar = "2027-07-23T12:00:00.000Z";
    const current = entitlementRow({ plan: "premium", premiumUntil: paidFar });

    const state = applyBillingEvent(current, {
      type: "payment_failed",
      eventId: "evt-3",
      provider: "fake",
      workspaceId: "ws-1",
      occurredAt: NOW,
      customerId: null,
      subscriptionId: "sub-1",
    });

    expect(state.premiumUntil).toBe(paidFar);
  });

  it("lifetime: la compra one-time aplica el grant indefinido (el carril del grant manual)", () => {
    const state = applyBillingEvent(null, {
      type: "lifetime_purchased",
      eventId: "evt-4",
      provider: "fake",
      workspaceId: "ws-1",
      occurredAt: NOW,
      customerId: "cus-1",
    });

    expect(state.premiumUntil).toBeNull();
    expect(state.subscriptionId).toBeNull();
    expect(state.subscriptionStatus).toBeNull();
    expect(state.billingCustomerId).toBe("cus-1");
    expect(
      deriveEffectivePlan(
        { plan: "premium", premiumUntil: null, trialEndsAt: null },
        "2036-01-01T00:00:00.000Z",
      ),
    ).toBe("premium");
  });

  it("un grant indefinido (lifetime o palanca admin) nunca se acorta por eventos de suscripción", () => {
    const current = entitlementRow({
      plan: "premium",
      premiumUntil: null,
      billingCustomerId: "cus-1",
      subscriptionId: "sub-1",
    });

    const canceled = applyBillingEvent(current, {
      type: "subscription_canceled",
      eventId: "evt-5",
      provider: "fake",
      workspaceId: "ws-1",
      occurredAt: NOW,
      customerId: "cus-1",
      subscriptionId: "sub-1",
      paidUntil: PERIOD_END,
    });
    expect(canceled.premiumUntil).toBeNull();
    expect(canceled.subscriptionStatus).toBe("canceled");

    const failed = applyBillingEvent(current, {
      type: "payment_failed",
      eventId: "evt-6",
      provider: "fake",
      workspaceId: "ws-1",
      occurredAt: NOW,
      customerId: "cus-1",
      subscriptionId: "sub-1",
    });
    expect(failed.premiumUntil).toBeNull();
  });

  it("las referencias del MoR caen a las almacenadas cuando el evento no las trae", () => {
    const current = entitlementRow({
      billingCustomerId: "cus-stored",
      subscriptionId: "sub-stored",
    });

    const state = applyBillingEvent(current, {
      type: "subscription_canceled",
      eventId: "evt-7",
      provider: "fake",
      workspaceId: "ws-1",
      occurredAt: NOW,
      customerId: null,
      subscriptionId: "sub-stored",
      paidUntil: null,
    });

    expect(state.billingCustomerId).toBe("cus-stored");
    expect(state.subscriptionId).toBe("sub-stored");
  });
});

describe("billingStateFromSubscription (re-sync /admin, PRD #1160 S5)", () => {
  it("una suscripción activa reescribe la ventana al fin de periodo del MoR", () => {
    const state = billingStateFromSubscription(null, {
      provider: "fake",
      subscriptionId: "sub-1",
      state: { status: "active", customerId: "cus-1", paidUntil: PERIOD_END },
      nowIso: NOW,
    });

    expect(state.premiumUntil).toBe(PERIOD_END);
    expect(state.subscriptionStatus).toBe("active");
    expect(state.subscriptionId).toBe("sub-1");
  });

  it("activa sin fin de periodo conocido conserva la ventana almacenada antes que inventar una", () => {
    const current = entitlementRow({ plan: "premium", premiumUntil: PERIOD_END });

    const state = billingStateFromSubscription(current, {
      provider: "fake",
      subscriptionId: "sub-1",
      state: { status: "active", customerId: null, paidUntil: null },
      nowIso: NOW,
    });

    expect(state.premiumUntil).toBe(PERIOD_END);
  });

  it("impago vía re-sync abre la misma gracia corta que el webhook", () => {
    const state = billingStateFromSubscription(null, {
      provider: "fake",
      subscriptionId: "sub-1",
      state: { status: "past_due", customerId: null, paidUntil: null },
      nowIso: NOW,
    });

    const graceEnd = new Date(
      Date.parse(NOW) + PAYMENT_GRACE_DAYS * DAY_MS,
    ).toISOString();
    expect(state.premiumUntil).toBe(graceEnd);
    expect(state.subscriptionStatus).toBe("past_due");
  });

  it("cancelada vía re-sync respeta el fin de periodo que informe el MoR", () => {
    const state = billingStateFromSubscription(null, {
      provider: "fake",
      subscriptionId: "sub-1",
      state: { status: "canceled", customerId: null, paidUntil: PERIOD_END },
      nowIso: NOW,
    });

    expect(state.premiumUntil).toBe(PERIOD_END);
    expect(state.subscriptionStatus).toBe("canceled");
  });
});
