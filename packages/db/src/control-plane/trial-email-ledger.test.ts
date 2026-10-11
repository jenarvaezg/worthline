import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createInMemoryControlPlaneStore,
  type EntitlementDirectory,
  type TenancyDirectory,
  type TrialEmailLedger,
} from "@db/control-plane";
import {
  CP_SCHEMA_VERSION,
  migrateControlPlane,
  readControlPlaneSchemaVersion,
  writeControlPlaneSchemaVersion,
} from "@db/control-plane/migrate";
import { openLibsqlClient } from "@db/libsql-client";
import { afterAll, describe, expect, it } from "vitest";

// The trial emails (#1173) read the trial off the entitlement tables and keep
// their own set-once marks beside them, so these tests seed through the real
// tenancy + entitlement ports and observe only through the ledger.
type Store = TrialEmailLedger &
  EntitlementDirectory &
  TenancyDirectory & { close(): void };

const STARTED = "2026-10-01T10:00:00.000Z";
const ENDS = "2026-10-04T10:00:00.000Z";

async function seedTrial(
  store: Store,
  email = "ana@example.com",
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

describe("trial email ledger (#1173)", () => {
  it("lists a trialing owner with what the emails need: address, window, plan, no marks", async () => {
    const store: Store = await createInMemoryControlPlaneStore();
    const { userId, workspaceId } = await seedTrial(store);

    const candidates = await store.listTrialEmailCandidates({
      trialEndsAfter: "2026-09-30T00:00:00.000Z",
    });

    expect(candidates).toEqual([
      {
        claimedKinds: [],
        email: "ana@example.com",
        plan: "trial",
        premiumUntil: null,
        remindersOptedOutAt: null,
        trialEndsAt: ENDS,
        trialStartedAt: STARTED,
        userId,
        workspaceId,
      },
    ]);
    store.close();
  });

  it("leaves out trials that closed before the cutoff, and workspaces that never trialed", async () => {
    const store: Store = await createInMemoryControlPlaneStore();
    await seedTrial(store, "old@example.com", "2026-08-01T10:00:00.000Z");
    const recent = await seedTrial(store, "new@example.com");
    // A workspace whose owner never got a trial (pre-#1161, or a re-provision).
    const user = await store.findOrCreateUser("free@example.com");
    const ws = await store.createWorkspace({
      dbName: "wl-free",
      dbUrl: "file:free.sqlite",
    });
    await store.recordGrant(user.id, ws.id);
    await store.markWorkspaceOnboarded(ws.id, STARTED);

    const candidates = await store.listTrialEmailCandidates({
      trialEndsAfter: "2026-10-02T00:00:00.000Z",
    });

    expect(candidates.map((candidate) => candidate.userId)).toEqual([recent.userId]);
    store.close();
  });

  it("a claim is set-once per identity and kind: the second claim loses", async () => {
    const store: Store = await createInMemoryControlPlaneStore();
    const { userId } = await seedTrial(store);

    expect(await store.claimTrialEmail({ at: STARTED, kind: "welcome", userId })).toBe(
      true,
    );
    expect(await store.claimTrialEmail({ at: STARTED, kind: "welcome", userId })).toBe(
      false,
    );
    // Another kind is its own mark.
    expect(
      await store.claimTrialEmail({ at: STARTED, kind: "trial_reminder", userId }),
    ).toBe(true);

    const [candidate] = await store.listTrialEmailCandidates({ trialEndsAfter: STARTED });
    expect(candidate?.claimedKinds.sort()).toEqual(["trial_reminder", "welcome"]);
    store.close();
  });

  it("releasing an unsent claim lets the next pass claim it again", async () => {
    const store: Store = await createInMemoryControlPlaneStore();
    const { userId } = await seedTrial(store);

    await store.claimTrialEmail({ at: STARTED, kind: "welcome", userId });
    await store.releaseTrialEmail({ kind: "welcome", userId });

    expect(await store.claimTrialEmail({ at: STARTED, kind: "welcome", userId })).toBe(
      true,
    );
    store.close();
  });

  it("a confirmed send can never be released: once sent, never again", async () => {
    const store: Store = await createInMemoryControlPlaneStore();
    const { userId } = await seedTrial(store);

    await store.claimTrialEmail({ at: STARTED, kind: "welcome", userId });
    await store.confirmTrialEmail({
      at: STARTED,
      kind: "welcome",
      providerMessageId: "re_123",
      userId,
    });
    await store.releaseTrialEmail({ kind: "welcome", userId });

    expect(await store.claimTrialEmail({ at: STARTED, kind: "welcome", userId })).toBe(
      false,
    );
    store.close();
  });

  it("the reminder opt-out is per identity and set-once: the first stamp stays", async () => {
    const store: Store = await createInMemoryControlPlaneStore();
    const { userId } = await seedTrial(store);

    await store.optOutOfTrialReminders({ at: "2026-10-02T08:00:00.000Z", userId });
    await store.optOutOfTrialReminders({ at: "2026-10-03T08:00:00.000Z", userId });

    const [candidate] = await store.listTrialEmailCandidates({ trialEndsAfter: STARTED });
    expect(candidate?.remindersOptedOutAt).toBe("2026-10-02T08:00:00.000Z");
    store.close();
  });

  it("reflects a premium grant on the trialing workspace, so the caller can derive the plan", async () => {
    const store: Store = await createInMemoryControlPlaneStore();
    const { workspaceId } = await seedTrial(store);
    await store.grantWorkspacePremium({ premiumUntil: null, workspaceId });

    const [candidate] = await store.listTrialEmailCandidates({ trialEndsAfter: STARTED });
    expect(candidate?.plan).toBe("premium");
    expect(candidate?.premiumUntil).toBeNull();
    store.close();
  });
});

describe("control-plane trial email migration (#1173)", () => {
  const tempDirs: string[] = [];
  afterAll(() => {
    for (const dir of tempDirs) rmSync(dir, { force: true, recursive: true });
  });

  it("a v9 control plane gains the marks and the preferences tables", async () => {
    const dir = mkdtempSync(join(tmpdir(), "worthline-cp-trial-email-"));
    tempDirs.push(dir);
    const client = openLibsqlClient({ url: `file:${join(dir, "cp.sqlite")}` });
    await writeControlPlaneSchemaVersion(client, 9);

    await migrateControlPlane(client);

    expect(await readControlPlaneSchemaVersion(client)).toBe(CP_SCHEMA_VERSION);
    expect(CP_SCHEMA_VERSION).toBeGreaterThanOrEqual(10);
    const tables = await client.execute(
      `SELECT name FROM sqlite_master WHERE type = 'table'
       AND name IN ('trial_email_sends', 'email_preferences') ORDER BY name`,
    );
    expect(tables.rows.map((row) => row["name"])).toEqual([
      "email_preferences",
      "trial_email_sends",
    ]);
    client.close();
  });
});
