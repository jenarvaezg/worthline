import type {
  ControlPlaneWorkspaceWithOwner,
  EntitlementDirectory,
  TenancyDirectory,
  UsageLimits,
  WorkspaceEntitlement,
} from "@worthline/db";
import { describe, expect, it, vi } from "vitest";

import {
  buildAdminEntitlementRows,
  listAdminEntitlements,
} from "./list-admin-entitlements";

const NOW = "2026-07-22T12:00:00.000Z";

function workspace(
  id: string,
  ownerEmail: string | null = `${id}@example.com`,
): ControlPlaneWorkspaceWithOwner {
  return {
    id,
    dbName: `wl-${id}`,
    dbUrl: `libsql://wl-${id}.turso.io`,
    createdAt: "2026-05-01T00:00:00.000Z",
    ownerEmail,
  };
}

function entitlement(
  partial: Partial<WorkspaceEntitlement> & { workspaceId: string },
): WorkspaceEntitlement {
  return {
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
    ...partial,
  };
}

describe("buildAdminEntitlementRows", () => {
  it("keeps workspaces as the spine — one row each, even with no entitlement row (free)", () => {
    const rows = buildAdminEntitlementRows({
      workspaces: [workspace("ws-a"), workspace("ws-b", null)],
      entitlements: [],
      tokenUsage: [],
      now: NOW,
    });

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      workspaceId: "ws-a",
      ownerEmail: "ws-a@example.com",
      effectivePlan: "free",
      declaredPlan: null,
      tokensToday: 0,
    });
    expect(rows[1]).toMatchObject({
      workspaceId: "ws-b",
      ownerEmail: null,
      effectivePlan: "free",
    });
  });

  it("derives the effective plan (not the stored plan) and flags an indefinite premium", () => {
    const rows = buildAdminEntitlementRows({
      workspaces: [workspace("ws-a")],
      entitlements: [
        entitlement({ workspaceId: "ws-a", plan: "premium", premiumUntil: null }),
      ],
      tokenUsage: [],
      now: NOW,
    });

    expect(rows[0]).toMatchObject({
      effectivePlan: "premium",
      declaredPlan: "premium",
      isIndefinitePremium: true,
    });
  });

  it("derives free from a lapsed dated grant even though the stored plan is still premium", () => {
    const rows = buildAdminEntitlementRows({
      workspaces: [workspace("ws-a")],
      entitlements: [
        entitlement({
          workspaceId: "ws-a",
          plan: "premium",
          premiumUntil: "2026-07-01T00:00:00.000Z",
        }),
      ],
      tokenUsage: [],
      now: NOW,
    });

    expect(rows[0]).toMatchObject({
      effectivePlan: "free",
      declaredPlan: "premium",
      isIndefinitePremium: false,
      premiumUntil: "2026-07-01T00:00:00.000Z",
    });
  });

  it("joins today's per-workspace token spend, defaulting to zero", () => {
    const rows = buildAdminEntitlementRows({
      workspaces: [workspace("ws-a"), workspace("ws-b")],
      entitlements: [],
      tokenUsage: [{ workspaceId: "ws-a", tokens: 4200 }],
      now: NOW,
    });

    expect(rows.find((r) => r.workspaceId === "ws-a")!.tokensToday).toBe(4200);
    expect(rows.find((r) => r.workspaceId === "ws-b")!.tokensToday).toBe(0);
  });
});

describe("listAdminEntitlements", () => {
  it("reads the three ports (today's UTC day keys the token read) and joins them", async () => {
    const listWorkspacesWithOwners = vi.fn().mockResolvedValue([workspace("ws-a")]);
    const listWorkspaceEntitlements = vi.fn().mockResolvedValue([
      entitlement({
        workspaceId: "ws-a",
        plan: "trial",
        trialEndsAt: "2026-07-25T00:00:00.000Z",
      }),
    ]);
    const listWorkspaceAiTokenUsage = vi
      .fn()
      .mockResolvedValue([{ workspaceId: "ws-a", tokens: 10 }]);

    const store: Pick<TenancyDirectory, "listWorkspacesWithOwners"> &
      Pick<EntitlementDirectory, "listWorkspaceEntitlements"> &
      Pick<UsageLimits, "listWorkspaceAiTokenUsage"> = {
      listWorkspacesWithOwners,
      listWorkspaceEntitlements,
      listWorkspaceAiTokenUsage,
    };

    const rows = await listAdminEntitlements(NOW, store);

    expect(listWorkspaceAiTokenUsage).toHaveBeenCalledWith("2026-07-22");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      workspaceId: "ws-a",
      effectivePlan: "trial",
      tokensToday: 10,
    });
  });
});
