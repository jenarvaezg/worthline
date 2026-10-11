import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createInMemoryControlPlaneStore,
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

// The marks carry a foreign key to `users`, so each test seeds a real identity
// through tenancy and then observes only through the ledger.
type Store = TrialEmailLedger & TenancyDirectory & { close(): void };

const AT = "2026-10-01T10:00:00.000Z";

async function withIdentity(): Promise<{ store: Store; userId: string }> {
  const store: Store = await createInMemoryControlPlaneStore();
  const user = await store.findOrCreateUser("ana@example.com");
  return { store, userId: user.id };
}

describe("trial email ledger (#1173)", () => {
  it("an identity nobody has written to has no marks and has declined nothing", async () => {
    const { store, userId } = await withIdentity();

    expect(await store.readTrialEmailMarks(userId)).toEqual({
      claimedKinds: [],
      remindersOptedOutAt: null,
    });
    store.close();
  });

  it("a claim is set-once per identity and kind: the second claim loses", async () => {
    const { store, userId } = await withIdentity();

    expect(await store.claimTrialEmail({ at: AT, kind: "welcome", userId })).toBe(true);
    expect(await store.claimTrialEmail({ at: AT, kind: "welcome", userId })).toBe(false);
    // Another kind is its own mark.
    expect(await store.claimTrialEmail({ at: AT, kind: "trial_reminder", userId })).toBe(
      true,
    );

    const marks = await store.readTrialEmailMarks(userId);
    expect([...marks.claimedKinds].sort()).toEqual(["trial_reminder", "welcome"]);
    store.close();
  });

  it("marks are per identity: one identity's claim never blocks another's", async () => {
    const { store, userId } = await withIdentity();
    const other = await store.findOrCreateUser("leo@example.com");

    await store.claimTrialEmail({ at: AT, kind: "welcome", userId });

    expect(
      await store.claimTrialEmail({ at: AT, kind: "welcome", userId: other.id }),
    ).toBe(true);
    store.close();
  });

  it("releasing an unsent claim lets the next pass claim it again", async () => {
    const { store, userId } = await withIdentity();

    await store.claimTrialEmail({ at: AT, kind: "welcome", userId });
    await store.releaseTrialEmail({ kind: "welcome", userId });

    expect((await store.readTrialEmailMarks(userId)).claimedKinds).toEqual([]);
    expect(await store.claimTrialEmail({ at: AT, kind: "welcome", userId })).toBe(true);
    store.close();
  });

  it("a confirmed send can never be released: once sent, never again", async () => {
    const { store, userId } = await withIdentity();

    await store.claimTrialEmail({ at: AT, kind: "welcome", userId });
    await store.confirmTrialEmail({
      at: AT,
      kind: "welcome",
      providerMessageId: "re_123",
      userId,
    });
    await store.releaseTrialEmail({ kind: "welcome", userId });

    expect(await store.claimTrialEmail({ at: AT, kind: "welcome", userId })).toBe(false);
    store.close();
  });

  it("the reminder opt-out is per identity and set-once: the first stamp stays", async () => {
    const { store, userId } = await withIdentity();

    await store.optOutOfTrialReminders({ at: "2026-10-02T08:00:00.000Z", userId });
    await store.optOutOfTrialReminders({ at: "2026-10-03T08:00:00.000Z", userId });

    expect((await store.readTrialEmailMarks(userId)).remindersOptedOutAt).toBe(
      "2026-10-02T08:00:00.000Z",
    );
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
