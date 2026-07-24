import type { StoreTarget } from "@web/store-resolver";
import type { WorkspaceEntitlement } from "@worthline/db";
import { describe, expect, it } from "vitest";

import { shouldEnterOnboarding } from "./onboarding-redirect";

const NOW = "2026-07-23T10:00:00.000Z";

function entitlement(overrides: Partial<WorkspaceEntitlement>): WorkspaceEntitlement {
  return {
    workspaceId: "wl_ws_1",
    plan: "trial",
    trialEndsAt: "2026-07-26T10:00:00.000Z",
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

describe("shouldEnterOnboarding", () => {
  it("enters onboarding for a brand-new provisioned workspace (both marks unset)", () => {
    expect(shouldEnterOnboarding(authenticated, entitlement({}))).toBe(true);
  });

  it("enters onboarding when the workspace has no entitlement row yet", () => {
    expect(shouldEnterOnboarding(authenticated, null)).toBe(true);
  });

  it("does not force onboarding once the workspace has onboarded (skip or complete)", () => {
    expect(shouldEnterOnboarding(authenticated, entitlement({ onboardedAt: NOW }))).toBe(
      false,
    );
  });

  it("does not force onboarding once the workspace already holds something", () => {
    // A first_holding mark means the workspace is live — never trap it behind
    // onboarding even if the onboarded mark was missed (best-effort, #1131).
    expect(
      shouldEnterOnboarding(authenticated, entitlement({ firstHoldingAt: NOW })),
    ).toBe(false);
  });

  it("never gates non-authenticated targets — the /app gate is hosted-only", () => {
    expect(shouldEnterOnboarding({ kind: "local" }, null)).toBe(false);
    expect(
      shouldEnterOnboarding({ kind: "demo", persona: "inversor", now: "" }, null),
    ).toBe(false);
    expect(shouldEnterOnboarding({ kind: "unauthenticated" }, null)).toBe(false);
  });

  it("does not force an impersonating admin into another user's onboarding", () => {
    const impersonating: StoreTarget = {
      ...authenticated,
      impersonatedEmail: "user@example.com",
    };
    expect(shouldEnterOnboarding(impersonating, entitlement({}))).toBe(false);
  });
});
