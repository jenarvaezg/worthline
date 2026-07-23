import type { WorkspaceEntitlement } from "@worthline/db";
import { describe, expect, it } from "vitest";

import { buildPremiumView } from "./premium-view";

const NOW = "2026-07-23T12:00:00.000Z";
const PERIOD_END = "2026-08-23T12:00:00.000Z";

function entitlement(
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

describe("buildPremiumView (PRD #1160 S5, #1165)", () => {
  it("free: ofrece el checkout y recuerda que lo manual es gratis para siempre", () => {
    const view = buildPremiumView({
      targetKind: "authenticated",
      entitlement: null,
      now: NOW,
    });

    expect(view.plan).toBe("free");
    expect(view.showCheckout).toBe(true);
    expect(view.showPortal).toBe(false);
  });

  it("trial: ofrece el checkout con la fecha de fin del trial en el estado", () => {
    const view = buildPremiumView({
      targetKind: "authenticated",
      entitlement: entitlement({ plan: "trial", trialEndsAt: PERIOD_END }),
      now: NOW,
    });

    expect(view.plan).toBe("trial");
    expect(view.showCheckout).toBe(true);
    expect(view.statusLine).toContain("23 ago");
  });

  it("suscripción activa: sin checkout (nada de doble compra), con portal", () => {
    const view = buildPremiumView({
      targetKind: "authenticated",
      entitlement: entitlement({
        plan: "premium",
        premiumUntil: PERIOD_END,
        billingCustomerId: "cus-1",
        subscriptionId: "sub-1",
        subscriptionStatus: "active",
      }),
      now: NOW,
    });

    expect(view.plan).toBe("premium");
    expect(view.showCheckout).toBe(false);
    expect(view.showPortal).toBe(true);
  });

  it("cancelada pero aún pagada: vuelve a ofrecer el checkout y mantiene el portal", () => {
    const view = buildPremiumView({
      targetKind: "authenticated",
      entitlement: entitlement({
        plan: "premium",
        premiumUntil: PERIOD_END,
        billingCustomerId: "cus-1",
        subscriptionId: "sub-1",
        subscriptionStatus: "canceled",
      }),
      now: NOW,
    });

    expect(view.showCheckout).toBe(true);
    expect(view.showPortal).toBe(true);
    expect(view.statusLine).toContain("no se renovará");
  });

  it("impago en gracia: sin checkout — el arreglo es el portal", () => {
    const view = buildPremiumView({
      targetKind: "authenticated",
      entitlement: entitlement({
        plan: "premium",
        premiumUntil: PERIOD_END,
        billingCustomerId: "cus-1",
        subscriptionId: "sub-1",
        subscriptionStatus: "past_due",
      }),
      now: NOW,
    });

    expect(view.showCheckout).toBe(false);
    expect(view.showPortal).toBe(true);
    expect(view.statusLine).toContain("pago pendiente");
  });

  it("premium indefinido (lifetime/beta): ni checkout ni urgencia", () => {
    const view = buildPremiumView({
      targetKind: "authenticated",
      entitlement: entitlement({ plan: "premium", premiumUntil: null }),
      now: NOW,
    });

    expect(view.plan).toBe("premium");
    expect(view.showCheckout).toBe(false);
    expect(view.statusLine).toContain("para siempre");
  });

  it("demo/local: sin planes que gestionar", () => {
    const demo = buildPremiumView({ targetKind: "demo", entitlement: null, now: NOW });
    const local = buildPremiumView({ targetKind: "local", entitlement: null, now: NOW });

    expect(demo.showCheckout).toBe(false);
    expect(local.showCheckout).toBe(false);
    expect(demo.showPortal).toBe(false);
  });
});
