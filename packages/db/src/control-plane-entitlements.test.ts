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
