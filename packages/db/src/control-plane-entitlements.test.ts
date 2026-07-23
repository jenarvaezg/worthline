import { describe, expect, it } from "vitest";

import {
  createInMemoryControlPlaneStore,
  type EntitlementDirectory,
  type TenancyDirectory,
} from "./control-plane";
import { deriveEffectivePlan, trialEndsAtFrom } from "./entitlements";

// Cross the real port seams: the in-memory store implements the whole control
// plane, but these tests depend only on tenancy (to seed real rows — the
// entitlement tables carry foreign keys) plus the entitlement concern.
type EntitlementStore = EntitlementDirectory & TenancyDirectory & { close(): void };

const NOW = "2026-07-22T12:00:00.000Z";

/** Seed a real user + n workspaces, so the FK-carrying entitlement writes land. */
async function seed(
  store: EntitlementStore,
  workspaces = 1,
): Promise<{ userId: string; workspaceIds: string[] }> {
  const user = await store.findOrCreateUser("ana@example.com");
  const workspaceIds: string[] = [];
  for (let i = 0; i < workspaces; i += 1) {
    const ws = await store.createWorkspace({
      dbName: `wl-test-${i}`,
      dbUrl: `file:wl-test-${i}.sqlite`,
    });
    workspaceIds.push(ws.id);
  }
  return { userId: user.id, workspaceIds };
}

describe("control plane entitlements (PRD #1160 S1)", () => {
  it("a workspace without a row reads as free — the pre-#1161 migration story", async () => {
    const store: EntitlementStore = await createInMemoryControlPlaneStore();
    const { workspaceIds } = await seed(store);

    const entitlement = await store.readWorkspaceEntitlement(workspaceIds[0]!);
    expect(entitlement).toBeNull();
    expect(deriveEffectivePlan(entitlement, NOW)).toBe("free");

    store.close();
  });

  it("startTrialIfUnused starts the trial with its window and stores plan=trial", async () => {
    const store: EntitlementStore = await createInMemoryControlPlaneStore();
    const { userId, workspaceIds } = await seed(store);

    const started = await store.startTrialIfUnused({
      now: NOW,
      userId,
      workspaceId: workspaceIds[0]!,
    });

    expect(started).not.toBeNull();
    expect(started!.plan).toBe("trial");
    expect(started!.trialEndsAt).toBe(trialEndsAtFrom(NOW));
    expect(deriveEffectivePlan(started, NOW)).toBe("trial");
    // …and the same row is what a later read sees.
    expect(await store.readWorkspaceEntitlement(workspaceIds[0]!)).toEqual(started);

    store.close();
  });

  it("one trial per identity: a second start for the same user is refused (#1128)", async () => {
    const store: EntitlementStore = await createInMemoryControlPlaneStore();
    const { userId, workspaceIds } = await seed(store, 2);

    await store.startTrialIfUnused({ now: NOW, userId, workspaceId: workspaceIds[0]! });
    const second = await store.startTrialIfUnused({
      now: NOW,
      userId,
      workspaceId: workspaceIds[1]!,
    });

    expect(second).toBeNull();
    // The refused workspace has no entitlement row — it reads as free.
    expect(await store.readWorkspaceEntitlement(workspaceIds[1]!)).toBeNull();

    store.close();
  });

  it("concurrent trial starts for the same identity yield exactly one trial", async () => {
    const store: EntitlementStore = await createInMemoryControlPlaneStore();
    const { userId, workspaceIds } = await seed(store, 2);

    const results = await Promise.all([
      store.startTrialIfUnused({ now: NOW, userId, workspaceId: workspaceIds[0]! }),
      store.startTrialIfUnused({ now: NOW, userId, workspaceId: workspaceIds[1]! }),
    ]);

    expect(results.filter((r) => r !== null)).toHaveLength(1);

    store.close();
  });

  it("the trial expires by derivation, not by any job", async () => {
    const store: EntitlementStore = await createInMemoryControlPlaneStore();
    const { userId, workspaceIds } = await seed(store);

    const started = await store.startTrialIfUnused({
      now: NOW,
      userId,
      workspaceId: workspaceIds[0]!,
    });

    const insideWindow = "2026-07-24T12:00:00.000Z";
    const afterWindow = "2026-07-26T12:00:00.000Z";
    expect(deriveEffectivePlan(started, insideWindow)).toBe("trial");
    expect(deriveEffectivePlan(started, afterWindow)).toBe("free");

    store.close();
  });

  it("markWorkspaceOnboarded is set-once: the first stamp wins", async () => {
    const store: EntitlementStore = await createInMemoryControlPlaneStore();
    const { workspaceIds } = await seed(store);
    const wsId = workspaceIds[0]!;

    await store.markWorkspaceOnboarded(wsId, "2026-07-22T10:00:00.000Z");
    await store.markWorkspaceOnboarded(wsId, "2026-07-23T10:00:00.000Z");

    const entitlement = await store.readWorkspaceEntitlement(wsId);
    expect(entitlement!.onboardedAt).toBe("2026-07-22T10:00:00.000Z");

    store.close();
  });

  it("markWorkspaceFirstHolding is set-once and independent of onboarding", async () => {
    const store: EntitlementStore = await createInMemoryControlPlaneStore();
    const { workspaceIds } = await seed(store);
    const wsId = workspaceIds[0]!;

    await store.markWorkspaceFirstHolding(wsId, "2026-07-22T10:00:00.000Z");
    await store.markWorkspaceFirstHolding(wsId, "2026-07-23T10:00:00.000Z");

    const entitlement = await store.readWorkspaceEntitlement(wsId);
    expect(entitlement!.firstHoldingAt).toBe("2026-07-22T10:00:00.000Z");
    expect(entitlement!.onboardedAt).toBeNull();

    store.close();
  });

  it("activation marks on a trial workspace never disturb the plan", async () => {
    const store: EntitlementStore = await createInMemoryControlPlaneStore();
    const { userId, workspaceIds } = await seed(store);
    const wsId = workspaceIds[0]!;

    await store.startTrialIfUnused({ now: NOW, userId, workspaceId: wsId });
    await store.markWorkspaceOnboarded(wsId, NOW);
    await store.markWorkspaceFirstHolding(wsId, NOW);

    const entitlement = await store.readWorkspaceEntitlement(wsId);
    expect(entitlement!.plan).toBe("trial");
    expect(entitlement!.trialEndsAt).toBe(trialEndsAtFrom(NOW));
    expect(entitlement!.onboardedAt).toBe(NOW);
    expect(entitlement!.firstHoldingAt).toBe(NOW);

    store.close();
  });

  it("a trial start after activation marks upgrades the same row, keeping the marks", async () => {
    const store: EntitlementStore = await createInMemoryControlPlaneStore();
    const { userId, workspaceIds } = await seed(store);
    const wsId = workspaceIds[0]!;

    // The activation mark can race ahead of the trial (both are best-effort
    // writes around provisioning) — the upsert must converge on one row.
    await store.markWorkspaceFirstHolding(wsId, NOW);
    const started = await store.startTrialIfUnused({
      now: NOW,
      userId,
      workspaceId: wsId,
    });

    expect(started!.plan).toBe("trial");
    expect(started!.firstHoldingAt).toBe(NOW);

    store.close();
  });
});

describe("admin premium palanca (PRD #1160 S4, #1164)", () => {
  const FUTURE = "2026-08-22T12:00:00.000Z";

  it("grants an indefinite premium (null window) that derives premium forever", async () => {
    const store: EntitlementStore = await createInMemoryControlPlaneStore();
    const { workspaceIds } = await seed(store);
    const wsId = workspaceIds[0]!;

    const granted = await store.grantWorkspacePremium({
      workspaceId: wsId,
      premiumUntil: null,
    });

    expect(granted.plan).toBe("premium");
    expect(granted.premiumUntil).toBeNull();
    expect(deriveEffectivePlan(granted, NOW)).toBe("premium");
    // No expiry job: an indefinite grant is still premium far in the future.
    expect(deriveEffectivePlan(granted, "2099-01-01T00:00:00.000Z")).toBe("premium");
    expect(await store.readWorkspaceEntitlement(wsId)).toEqual(granted);

    store.close();
  });

  it("grants a dated premium that lapses to free on its own after the window", async () => {
    const store: EntitlementStore = await createInMemoryControlPlaneStore();
    const { workspaceIds } = await seed(store);
    const wsId = workspaceIds[0]!;

    const granted = await store.grantWorkspacePremium({
      workspaceId: wsId,
      premiumUntil: FUTURE,
    });

    expect(granted.plan).toBe("premium");
    expect(granted.premiumUntil).toBe(FUTURE);
    expect(deriveEffectivePlan(granted, NOW)).toBe("premium");
    expect(deriveEffectivePlan(granted, "2026-09-01T00:00:00.000Z")).toBe("free");

    store.close();
  });

  it("upsizes a workspace that had no row, and overwrites an existing plan/window", async () => {
    const store: EntitlementStore = await createInMemoryControlPlaneStore();
    const { workspaceIds } = await seed(store);
    const wsId = workspaceIds[0]!;

    // Never had a row → the grant creates one.
    await store.grantWorkspacePremium({ workspaceId: wsId, premiumUntil: FUTURE });
    // A second grant overwrites the window (e.g. dated → indefinite).
    const regranted = await store.grantWorkspacePremium({
      workspaceId: wsId,
      premiumUntil: null,
    });

    expect(regranted.premiumUntil).toBeNull();
    expect(regranted.plan).toBe("premium");

    store.close();
  });

  it("preserves the trial marker and activation timestamps across a grant", async () => {
    const store: EntitlementStore = await createInMemoryControlPlaneStore();
    const { userId, workspaceIds } = await seed(store);
    const wsId = workspaceIds[0]!;

    await store.startTrialIfUnused({ now: NOW, userId, workspaceId: wsId });
    await store.markWorkspaceOnboarded(wsId, NOW);
    const granted = await store.grantWorkspacePremium({
      workspaceId: wsId,
      premiumUntil: null,
    });

    // The grant flips the plan but never rewrites history.
    expect(granted.plan).toBe("premium");
    expect(granted.trialEndsAt).toBe(trialEndsAtFrom(NOW));
    expect(granted.onboardedAt).toBe(NOW);

    store.close();
  });

  it("revokes a premium grant back to free, clearing only the window", async () => {
    const store: EntitlementStore = await createInMemoryControlPlaneStore();
    const { workspaceIds } = await seed(store);
    const wsId = workspaceIds[0]!;

    await store.grantWorkspacePremium({ workspaceId: wsId, premiumUntil: FUTURE });
    await store.revokeWorkspacePremium(wsId);

    const after = await store.readWorkspaceEntitlement(wsId);
    expect(after!.plan).toBe("free");
    expect(after!.premiumUntil).toBeNull();
    expect(deriveEffectivePlan(after, NOW)).toBe("free");

    store.close();
  });

  it("revoke is a no-op for a workspace with no row (already free)", async () => {
    const store: EntitlementStore = await createInMemoryControlPlaneStore();
    const { workspaceIds } = await seed(store);
    const wsId = workspaceIds[0]!;

    await store.revokeWorkspacePremium(wsId);

    expect(await store.readWorkspaceEntitlement(wsId)).toBeNull();

    store.close();
  });

  it("revoke leaves a still-live trial intact — it removes only the premium grant", async () => {
    const store: EntitlementStore = await createInMemoryControlPlaneStore();
    const { userId, workspaceIds } = await seed(store);
    const wsId = workspaceIds[0]!;

    await store.startTrialIfUnused({ now: NOW, userId, workspaceId: wsId });
    await store.grantWorkspacePremium({ workspaceId: wsId, premiumUntil: FUTURE });
    await store.revokeWorkspacePremium(wsId);

    const after = await store.readWorkspaceEntitlement(wsId);
    // The trial window survives, so derivation falls back to trial (not free).
    expect(after!.trialEndsAt).toBe(trialEndsAtFrom(NOW));
    const insideTrial = "2026-07-24T00:00:00.000Z";
    expect(deriveEffectivePlan(after, insideTrial)).toBe("trial");

    store.close();
  });

  it("lists every stored entitlement row for the /admin view", async () => {
    const store: EntitlementStore = await createInMemoryControlPlaneStore();
    const { userId, workspaceIds } = await seed(store, 2);

    await store.grantWorkspacePremium({
      workspaceId: workspaceIds[0]!,
      premiumUntil: null,
    });
    await store.startTrialIfUnused({ now: NOW, userId, workspaceId: workspaceIds[1]! });

    const rows = await store.listWorkspaceEntitlements();
    const byId = new Map(rows.map((r) => [r.workspaceId, r]));

    expect(rows).toHaveLength(2);
    expect(byId.get(workspaceIds[0]!)!.plan).toBe("premium");
    expect(byId.get(workspaceIds[1]!)!.plan).toBe("trial");

    store.close();
  });
});
