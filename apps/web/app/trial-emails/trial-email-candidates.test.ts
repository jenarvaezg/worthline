import { type ControlPlaneStore, createInMemoryControlPlaneStore } from "@worthline/db";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { listTrialEmailCandidates } from "./trial-email-candidates";

const STARTED = "2026-10-01T10:00:00.000Z";

let store: ControlPlaneStore;
beforeEach(async () => {
  store = await createInMemoryControlPlaneStore();
});
afterEach(() => store.close());

async function seedTrial(
  email: string,
  startedAt = STARTED,
): Promise<{ userId: string; workspaceId: string }> {
  const user = await store.findOrCreateUser(email);
  const workspace = await store.createWorkspace({
    dbName: `wl-${email}`,
    dbUrl: `file:${email}.sqlite`,
  });
  await store.recordGrant(user.id, workspace.id);
  await store.startTrialIfUnused({
    now: startedAt,
    userId: user.id,
    workspaceId: workspace.id,
  });
  return { userId: user.id, workspaceId: workspace.id };
}

describe("listTrialEmailCandidates (#1173)", () => {
  test("a trialing owner comes with its address, window, plan and (no) marks", async () => {
    const { userId, workspaceId } = await seedTrial("ana@example.com");

    expect(
      await listTrialEmailCandidates(store, {
        trialEndsAfter: "2026-09-30T00:00:00.000Z",
      }),
    ).toEqual([
      {
        claimedKinds: [],
        email: "ana@example.com",
        plan: "trial",
        premiumUntil: null,
        remindersOptedOutAt: null,
        trialEndsAt: "2026-10-04T10:00:00.000Z",
        userId,
        workspaceId,
      },
    ]);
  });

  test("leaves out trials that closed before the cutoff and workspaces that never trialed", async () => {
    await seedTrial("old@example.com", "2026-08-01T10:00:00.000Z");
    const recent = await seedTrial("new@example.com");
    const user = await store.findOrCreateUser("free@example.com");
    const ws = await store.createWorkspace({
      dbName: "wl-free",
      dbUrl: "file:free.sqlite",
    });
    await store.recordGrant(user.id, ws.id);
    await store.markWorkspaceOnboarded(ws.id, STARTED);

    const candidates = await listTrialEmailCandidates(store, {
      trialEndsAfter: "2026-10-02T00:00:00.000Z",
    });

    expect(candidates.map((candidate) => candidate.userId)).toEqual([recent.userId]);
  });

  test("carries the ledger's marks and the opt-out of each identity", async () => {
    const { userId } = await seedTrial("ana@example.com");
    await store.claimTrialEmail({ at: STARTED, kind: "welcome", userId });
    await store.optOutOfTrialReminders({ at: "2026-10-02T08:00:00.000Z", userId });

    const [candidate] = await listTrialEmailCandidates(store, {
      trialEndsAfter: STARTED,
    });

    expect(candidate?.claimedKinds).toEqual(["welcome"]);
    expect(candidate?.remindersOptedOutAt).toBe("2026-10-02T08:00:00.000Z");
  });

  test("reflects a premium grant on the trialing workspace, so the plan can be derived", async () => {
    const { workspaceId } = await seedTrial("ana@example.com");
    await store.grantWorkspacePremium({ premiumUntil: null, workspaceId });

    const [candidate] = await listTrialEmailCandidates(store, {
      trialEndsAfter: STARTED,
    });

    expect(candidate?.plan).toBe("premium");
    expect(candidate?.premiumUntil).toBeNull();
  });

  test("oldest window first", async () => {
    const later = await seedTrial("later@example.com", "2026-10-02T10:00:00.000Z");
    const sooner = await seedTrial("sooner@example.com", "2026-10-01T10:00:00.000Z");

    const candidates = await listTrialEmailCandidates(store, { trialEndsAfter: STARTED });

    expect(candidates.map((candidate) => candidate.userId)).toEqual([
      sooner.userId,
      later.userId,
    ]);
  });
});
