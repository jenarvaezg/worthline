/**
 * The sync state of a source that owns its holdings (#1884, ADR 0114 decisions 4
 * and 7), in the store, and the v78 rung that adds its table.
 *
 * - One pass per connection at a time: a lease claimed in ONE update, which a pass
 *   killed halfway cannot hold forever (it expires).
 * - At most 10 logins a day, reserved in ONE update before MyInvestor is asked.
 * - The password rejections of the day, the pause, the stop of the periodic sync and
 *   what the last pass found: the state the button, the cron and the band read.
 */
import { openLibsqlClient } from "@db/index";
import { migrate, SCHEMA_VERSION } from "@db/migrate";
import { schemaSql } from "@db/schema-sql";
import { createStoreFromSqlite } from "@db/testing";
import { wipeWorkspaceTables } from "@db/workspace-tables";
import type { Client } from "@libsql/client";
import { asDateKey } from "@worthline/domain";
import { describe, expect, test } from "vitest";

const SYNC_TABLE = "connected_source_sync_state";
const DAY = asDateKey("2026-11-04");
const NEXT_DAY = asDateKey("2026-11-05");

async function openStore() {
  const client: Client = openLibsqlClient(":memory:");
  await migrate(client);
  const store = await createStoreFromSqlite(client);
  await store.workspace.initializeWorkspace({
    members: [{ id: "mJ", name: "Titular" }],
    mode: "individual",
  });
  const { sourceId } = (await store.connectedSources.connectOwningSource({
    adapter: "myinvestor",
    credentialsJson: JSON.stringify({ deviceId: "device-under-test" }),
    label: "MyInvestor",
  }))!;
  return { client, sourceId, store };
}

describe("the sync lease (one pass per connection)", () => {
  test("a second claim while the first holds is refused and sees who holds it", async () => {
    const { sourceId, store } = await openStore();
    const sources = store.connectedSources;

    const first = await sources.claimSyncLease({
      now: "2026-11-04T07:10:00.000Z",
      sourceId,
      trigger: "cron",
      until: "2026-11-04T07:20:00.000Z",
    });
    expect(first).toEqual({ claimed: true });
    await sources.setSyncStep(sourceId, "orders");

    const second = await sources.claimSyncLease({
      now: "2026-11-04T07:11:00.000Z",
      sourceId,
      trigger: "manual",
      until: "2026-11-04T07:21:00.000Z",
    });
    expect(second).toEqual({
      claimed: false,
      held: {
        startedAt: "2026-11-04T07:10:00.000Z",
        step: "orders",
        trigger: "cron",
        until: "2026-11-04T07:20:00.000Z",
      },
    });

    await sources.releaseSyncLease(sourceId);
    expect(
      await sources.claimSyncLease({
        now: "2026-11-04T07:12:00.000Z",
        sourceId,
        trigger: "manual",
        until: "2026-11-04T07:22:00.000Z",
      }),
    ).toEqual({ claimed: true });
  });

  test("a lease past its expiry is taken over: a killed pass never wedges the button", async () => {
    const { sourceId, store } = await openStore();
    const sources = store.connectedSources;
    await sources.claimSyncLease({
      now: "2026-11-04T07:10:00.000Z",
      sourceId,
      trigger: "cron",
      until: "2026-11-04T07:20:00.000Z",
    });

    const taken = await sources.claimSyncLease({
      now: "2026-11-04T07:20:00.001Z",
      sourceId,
      trigger: "manual",
      until: "2026-11-04T07:30:00.001Z",
    });

    expect(taken).toEqual({ claimed: true });
    expect((await sources.readSyncState(sourceId))?.lease).toEqual({
      startedAt: "2026-11-04T07:20:00.001Z",
      step: null,
      trigger: "manual",
      until: "2026-11-04T07:30:00.001Z",
    });
  });

  test("two claims at once: exactly one wins", async () => {
    const { sourceId, store } = await openStore();
    const claim = () =>
      store.connectedSources.claimSyncLease({
        now: "2026-11-04T07:10:00.000Z",
        sourceId,
        trigger: "manual",
        until: "2026-11-04T07:20:00.000Z",
      });

    const results = await Promise.all([claim(), claim()]);

    expect(results.filter((result) => result.claimed)).toHaveLength(1);
  });
});

describe("the logins of the day (at most 10)", () => {
  test("the 11th login of a day is refused, and the next day starts again", async () => {
    const { sourceId, store } = await openStore();
    const sources = store.connectedSources;
    const reserved: (number | null)[] = [];
    for (let attempt = 0; attempt < 11; attempt += 1) {
      reserved.push(await sources.reserveSyncLogin({ cap: 10, day: DAY, sourceId }));
    }

    expect(reserved).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, null]);
    expect(await sources.reserveSyncLogin({ cap: 10, day: NEXT_DAY, sourceId })).toBe(1);
  });

  test("a rejection is all or nothing: deleted, counted, and the third locks the day", async () => {
    const { sourceId, store } = await openStore();
    const sources = store.connectedSources;
    const reject = (day: typeof DAY) =>
      sources.recordPasswordRejection({
        credentialsJson: JSON.stringify({ deviceId: "device-under-test" }),
        day,
        lockAfter: 3,
        lockedUntil: "2026-11-05T00:00:00.000Z",
        outcomeJson: { locked: '{"kind":"locked"}', rejected: '{"kind":"rejected"}' },
        sourceId,
      });

    await sources.reserveSyncLogin({ cap: 10, day: DAY, sourceId });
    expect(await reject(DAY)).toEqual({ locked: false, rejections: 1 });
    expect(await reject(DAY)).toEqual({ locked: false, rejections: 2 });
    expect(await sources.readSyncState(sourceId)).toMatchObject({
      lastOutcomeJson: '{"kind":"rejected"}',
      pausedUntil: null,
    });
    expect(await reject(DAY)).toEqual({ locked: true, rejections: 3 });
    expect(await sources.readSyncState(sourceId)).toMatchObject({
      lastOutcomeJson: '{"kind":"locked"}',
      pausedUntil: "2026-11-05T00:00:00.000Z",
    });
    // The credentials were rewritten in the same transaction, without the password.
    expect((await sources.readSource(sourceId))!.credentialsJson).toBe(
      JSON.stringify({ deviceId: "device-under-test" }),
    );

    await sources.reserveSyncLogin({ cap: 10, day: NEXT_DAY, sourceId });
    expect(await reject(NEXT_DAY)).toEqual({ locked: false, rejections: 1 });
  });

  test("a login day is a calendar day, never an instant", async () => {
    const { sourceId, store } = await openStore();
    await expect(
      store.connectedSources.reserveSyncLogin({
        cap: 10,
        day: "2026-11-04T07:10:00.000Z" as typeof DAY,
        sourceId,
      }),
    ).rejects.toThrow(/calendar day/);
  });
});

describe("what the passes leave", () => {
  test("the pause, the stop and the last outcome are kept and read back", async () => {
    const { sourceId, store } = await openStore();
    const sources = store.connectedSources;

    expect(await sources.readSyncState(sourceId)).toBeNull();
    await sources.updateSyncState(sourceId, {
      lastOutcomeJson: '{"kind":"sms_required"}',
      pausedUntil: "2026-11-05T07:10:00.000Z",
      stoppedReason: "sms_required",
      unitsCheckJson: "[]",
    });

    expect(await sources.readSyncState(sourceId)).toMatchObject({
      lastOutcomeJson: '{"kind":"sms_required"}',
      lease: null,
      pausedUntil: "2026-11-05T07:10:00.000Z",
      stoppedReason: "sms_required",
      unitsCheckJson: "[]",
    });

    await sources.updateSyncState(sourceId, { pausedUntil: null, stoppedReason: null });
    expect(await sources.readSyncState(sourceId)).toMatchObject({
      lastOutcomeJson: '{"kind":"sms_required"}',
      pausedUntil: null,
      stoppedReason: null,
    });
  });

  test("the state goes with the connection, and with a full replace", async () => {
    const { client, sourceId, store } = await openStore();
    await store.connectedSources.updateSyncState(sourceId, { stoppedReason: "x" });

    await store.connectedSources.disconnectOwningSource(sourceId);
    expect((await client.execute(`SELECT * FROM ${SYNC_TABLE}`)).rows).toHaveLength(0);

    const again = await openStore();
    await again.store.connectedSources.updateSyncState(again.sourceId, {
      stoppedReason: "x",
    });
    await wipeWorkspaceTables(again.client);
    expect((await again.client.execute(`SELECT * FROM ${SYNC_TABLE}`)).rows).toHaveLength(
      0,
    );
  });
});

/** Today's schema rolled back to v77: no sync-state table. */
function schemaAtV77(): string {
  return schemaSql
    .split("--> statement-breakpoint")
    .filter((statement) => !statement.includes(SYNC_TABLE))
    .join("--> statement-breakpoint");
}

async function seedAtV77(): Promise<Client> {
  const client = openLibsqlClient(":memory:");
  await client.executeMultiple(schemaAtV77());
  await client.execute("CREATE TABLE schema_meta (version INTEGER NOT NULL)");
  await client.execute("INSERT INTO schema_meta (version) VALUES (77)");
  await client.execute(
    `INSERT INTO connected_sources (id, adapter, label, asset_id, credentials_json)
     VALUES ('mi', 'myinvestor', 'MyInvestor', NULL, 'sealed')`,
  );
  return client;
}

async function tables(client: Client): Promise<string[]> {
  return (
    await client.execute("SELECT name FROM sqlite_master WHERE type = 'table'")
  ).rows.map((row) => String(row.name));
}

describe("schema migration v78 (the sync state of an owning source)", () => {
  test("adds the table, keeping the connection, and a re-run changes nothing", async () => {
    const client = await seedAtV77();
    expect(await tables(client)).not.toContain(SYNC_TABLE);

    await migrate(client);

    expect(SCHEMA_VERSION).toBe(78);
    expect(await tables(client)).toContain(SYNC_TABLE);
    await client.execute(
      `INSERT INTO ${SYNC_TABLE} (source_id, logins_today) VALUES ('mi', 3)`,
    );

    await client.execute("UPDATE schema_meta SET version = 77");
    await migrate(client);
    expect((await client.execute(`SELECT * FROM ${SYNC_TABLE}`)).rows).toHaveLength(1);
    expect((await client.execute("SELECT id FROM connected_sources")).rows).toEqual([
      { id: "mi" },
    ]);
  });
});
