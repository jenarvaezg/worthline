import type { StoreTarget } from "@web/store-resolver";
import type { WorkspaceEntitlement } from "@worthline/db";
import { describe, expect, it } from "vitest";

import { effectivePlanForTarget, isPremiumIngestionAllowed } from "./effective-plan";

const NOW = "2026-07-22T10:00:00.000Z";

function entitlement(overrides: Partial<WorkspaceEntitlement>): WorkspaceEntitlement {
  return {
    workspaceId: "wl_ws_1",
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

const authenticated: StoreTarget = {
  kind: "authenticated",
  workspaceId: "wl_ws_1",
  dbUrl: "libsql://ws",
  token: "t",
};

describe("effectivePlanForTarget", () => {
  it("bypasses local dev to premium — the developer owns the shared key", () => {
    expect(effectivePlanForTarget({ kind: "local" }, null, NOW)).toBe("premium");
  });

  it("bypasses the demo showcase to premium so it demonstrates every surface", () => {
    const demo: StoreTarget = { kind: "demo", persona: "inversor", now: "" };
    expect(effectivePlanForTarget(demo, null, NOW)).toBe("premium");
  });

  it("treats an unauthenticated caller as free", () => {
    expect(effectivePlanForTarget({ kind: "unauthenticated" }, null, NOW)).toBe("free");
  });

  it("derives an authenticated workspace from its stored row (missing row → free)", () => {
    expect(effectivePlanForTarget(authenticated, null, NOW)).toBe("free");
  });

  it("honors a live trial for an authenticated workspace", () => {
    const row = entitlement({ plan: "trial", trialEndsAt: "2026-07-25T10:00:00.000Z" });
    expect(effectivePlanForTarget(authenticated, row, NOW)).toBe("trial");
  });

  it("falls a lapsed trial back to free", () => {
    const row = entitlement({ plan: "trial", trialEndsAt: "2026-07-20T10:00:00.000Z" });
    expect(effectivePlanForTarget(authenticated, row, NOW)).toBe("free");
  });

  it("honors an indefinite premium grant", () => {
    const row = entitlement({ plan: "premium", premiumUntil: null });
    expect(effectivePlanForTarget(authenticated, row, NOW)).toBe("premium");
  });
});

describe("isPremiumIngestionAllowed", () => {
  it("allows premium and trial, blocks free", () => {
    expect(isPremiumIngestionAllowed("premium")).toBe(true);
    expect(isPremiumIngestionAllowed("trial")).toBe(true);
    expect(isPremiumIngestionAllowed("free")).toBe(false);
  });
});
