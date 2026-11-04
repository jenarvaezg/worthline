/**
 * The MyInvestor connection in the store (#1879, ADR 0114/0115).
 *
 * - `connectOwningSource` writes a `connected_sources` row with NO mirror asset:
 *   MyInvestor owns its holdings through operations, and they arrive later (#1880).
 * - Its credentials are sealed at rest like every other source's (ADR 0030).
 * - The pending login of the two-step SMS lives in the database, sealed, with an
 *   expiry, one per adapter (ADR 0114 decision 6).
 * - Disconnecting deletes the credentials at once and freezes each linked holding
 *   as manual, keeping its own instrument (ADR 0115 decision 6).
 */
import { openLibsqlClient } from "@db/index";
import { migrate } from "@db/migrate";
import { createStoreFromSqlite } from "@db/testing";
import { wipeWorkspaceTables } from "@db/workspace-tables";
import type { Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

const KEY_ENV = "WORTHLINE_ENCRYPTION_KEY";
const savedKey = process.env[KEY_ENV];

beforeEach(() => {
  process.env[KEY_ENV] = "test-key-for-myinvestor";
});

afterEach(() => {
  if (savedKey === undefined) delete process.env[KEY_ENV];
  else process.env[KEY_ENV] = savedKey;
});

async function openStore() {
  const client: Client = openLibsqlClient(":memory:");
  await migrate(client);
  const store = await createStoreFromSqlite(client);
  await store.workspace.initializeWorkspace({
    members: [{ id: "mJ", name: "Titular" }],
    mode: "individual",
  });
  return { client, store };
}

const CREDENTIALS = JSON.stringify({ deviceId: "device-under-test" });

describe("connectOwningSource", () => {
  test("connects MyInvestor with no mirror asset and its credentials sealed", async () => {
    const { client, store } = await openStore();

    const { sourceId } = (await store.connectedSources.connectOwningSource({
      adapter: "myinvestor",
      credentialsJson: CREDENTIALS,
      label: "MyInvestor",
    }))!;

    const [source] = await store.connectedSources.listSources();
    expect(source).toMatchObject({
      adapter: "myinvestor",
      assetId: null,
      credentialsJson: CREDENTIALS,
      id: sourceId,
      label: "MyInvestor",
      lastSyncAt: null,
    });
    // No holding appears: what MyInvestor holds is chosen in the next step (#1880).
    expect(await store.assets.readAssets()).toEqual([]);

    const raw = await client.execute("SELECT credentials_json FROM connected_sources");
    expect(String(raw.rows[0]!.credentials_json)).not.toContain("device-under-test");
  });
});

describe("pending logins", () => {
  test("keep their payload sealed, with an expiry, and read back opened", async () => {
    const { client, store } = await openStore();

    const { id } = await store.connectedSources.startPendingLogin({
      adapter: "myinvestor",
      expiresAt: "2026-11-04T12:05:00.000Z",
      payloadJson: JSON.stringify({ requestId: "request-under-test" }),
    });

    expect(await store.connectedSources.readPendingLogin(id)).toEqual({
      adapter: "myinvestor",
      expiresAt: "2026-11-04T12:05:00.000Z",
      id,
      payloadJson: JSON.stringify({ requestId: "request-under-test" }),
    });
    const raw = await client.execute(
      "SELECT payload_json FROM connected_source_pending_logins",
    );
    expect(String(raw.rows[0]!.payload_json)).not.toContain("request-under-test");
  });

  test("starting again replaces the previous one: at most one per adapter", async () => {
    const { store } = await openStore();
    const first = await store.connectedSources.startPendingLogin({
      adapter: "myinvestor",
      expiresAt: "2026-11-04T12:05:00.000Z",
      payloadJson: "{}",
    });

    const second = await store.connectedSources.startPendingLogin({
      adapter: "myinvestor",
      expiresAt: "2026-11-04T12:09:00.000Z",
      payloadJson: "{}",
    });

    expect(await store.connectedSources.readPendingLogin(first.id)).toBeNull();
    expect(await store.connectedSources.readPendingLogin(second.id)).not.toBeNull();
  });

  test("an expired one is swept, a live one stays (an abandoned tab must not keep a password)", async () => {
    const { client, store } = await openStore();
    const { id } = await store.connectedSources.startPendingLogin({
      adapter: "myinvestor",
      expiresAt: "2026-11-04T12:05:00.000Z",
      payloadJson: "{}",
    });

    expect(
      await store.connectedSources.purgeExpiredPendingLogins("2026-11-04T12:04:59.000Z"),
    ).toBe(0);
    expect(await store.connectedSources.readPendingLogin(id)).not.toBeNull();

    expect(
      await store.connectedSources.purgeExpiredPendingLogins("2026-11-04T12:05:00.001Z"),
    ).toBe(1);
    expect(
      (await client.execute("SELECT * FROM connected_source_pending_logins")).rows,
    ).toHaveLength(0);
  });

  test("a code attempt is reserved atomically, up to the cap", async () => {
    // Reserved BEFORE MyInvestor is asked, in one UPDATE: two codes sent at once
    // cannot both read the same count and slip past the cap.
    const { store } = await openStore();
    const { id } = await store.connectedSources.startPendingLogin({
      adapter: "myinvestor",
      expiresAt: "2026-11-04T12:05:00.000Z",
      payloadJson: "{}",
    });

    const reserved = await Promise.all([
      store.connectedSources.reservePendingCodeAttempt(id, 3),
      store.connectedSources.reservePendingCodeAttempt(id, 3),
      store.connectedSources.reservePendingCodeAttempt(id, 3),
      store.connectedSources.reservePendingCodeAttempt(id, 3),
    ]);

    expect(reserved.filter((attempt) => attempt !== null).sort()).toEqual([1, 2, 3]);
    expect(reserved.filter((attempt) => attempt === null)).toHaveLength(1);
    expect(
      await store.connectedSources.reservePendingCodeAttempt("unknown", 3),
    ).toBeNull();
  });

  test("a workspace reset deletes them with everything else", async () => {
    const { client, store } = await openStore();
    await store.connectedSources.startPendingLogin({
      adapter: "myinvestor",
      expiresAt: "2026-11-04T12:05:00.000Z",
      payloadJson: "{}",
    });

    await wipeWorkspaceTables(client);

    expect(
      (await client.execute("SELECT * FROM connected_source_pending_logins")).rows,
    ).toHaveLength(0);
  });

  test("a deleted or unknown pending login reads as null", async () => {
    const { store } = await openStore();
    const { id } = await store.connectedSources.startPendingLogin({
      adapter: "myinvestor",
      expiresAt: "2026-11-04T12:05:00.000Z",
      payloadJson: "{}",
    });

    await store.connectedSources.deletePendingLogin(id);

    expect(await store.connectedSources.readPendingLogin(id)).toBeNull();
    expect(await store.connectedSources.readPendingLogin("unknown")).toBeNull();
  });
});

describe("one MyInvestor connection per workspace", () => {
  test("a second connection is refused, not written", async () => {
    const { store } = await openStore();
    await store.connectedSources.connectOwningSource({
      adapter: "myinvestor",
      credentialsJson: CREDENTIALS,
      label: "MyInvestor",
    });

    expect(
      await store.connectedSources.connectOwningSource({
        adapter: "myinvestor",
        credentialsJson: CREDENTIALS,
        label: "MyInvestor",
      }),
    ).toBeNull();
    expect(await store.connectedSources.listSources()).toHaveLength(1);
  });
});

describe("the mirroring disconnect never touches MyInvestor", () => {
  test("removeSourceHoldings refuses an owning source and deletes none of its holdings", async () => {
    const { client, store } = await openStore();
    const connected = await store.connectedSources.connectOwningSource({
      adapter: "myinvestor",
      credentialsJson: CREDENTIALS,
      label: "MyInvestor",
    });
    const sourceId = connected!.sourceId;
    await client.execute({
      args: [sourceId],
      sql: `INSERT INTO assets (id, name, type, currency, current_value_minor, liquidity_tier, instrument, connected_source_id)
            VALUES ('fund', 'Un fondo', 'investment', 'EUR', 1000, 'market', 'fund', ?)`,
    });

    expect(await store.connectedSources.removeSourceHoldings(sourceId)).toEqual({
      removed: 0,
    });

    expect(await store.connectedSources.listSources()).toHaveLength(1);
    expect((await client.execute("SELECT id FROM assets")).rows).toHaveLength(1);
  });
});

describe("disconnectOwningSource", () => {
  test("deletes the connection and its credentials at once", async () => {
    const { client, store } = await openStore();
    const { sourceId } = (await store.connectedSources.connectOwningSource({
      adapter: "myinvestor",
      credentialsJson: CREDENTIALS,
      label: "MyInvestor",
    }))!;
    await store.connectedSources.startPendingLogin({
      adapter: "myinvestor",
      expiresAt: "2026-11-04T12:05:00.000Z",
      payloadJson: "{}",
    });

    expect(await store.connectedSources.disconnectOwningSource(sourceId)).toEqual({
      frozen: 0,
    });

    expect(await store.connectedSources.listSources()).toEqual([]);
    expect(
      (await client.execute("SELECT * FROM connected_source_pending_logins")).rows,
    ).toHaveLength(0);
  });

  test("freezes each linked holding as manual, keeping its own instrument", async () => {
    const { client, store } = await openStore();
    const { sourceId } = (await store.connectedSources.connectOwningSource({
      adapter: "myinvestor",
      credentialsJson: CREDENTIALS,
      label: "MyInvestor",
    }))!;
    // A holding linked to the connection, the way #1880 will create them.
    await client.execute({
      args: [sourceId],
      sql: `INSERT INTO assets (id, name, type, currency, current_value_minor, liquidity_tier, instrument, connected_source_id)
            VALUES ('fund', 'Un fondo', 'investment', 'EUR', 1000, 'market', 'fund', ?)`,
    });

    expect(await store.connectedSources.disconnectOwningSource(sourceId)).toEqual({
      frozen: 1,
    });

    const row = (
      await client.execute(
        "SELECT instrument, connected_source_id, current_value_minor FROM assets WHERE id = 'fund'",
      )
    ).rows[0];
    expect(row).toMatchObject({
      connected_source_id: null,
      current_value_minor: 1000,
      instrument: "fund",
    });
  });

  test("refuses a mirroring source and an unknown id", async () => {
    const { store } = await openStore();
    const { sourceId } = await store.connectedSources.connect({
      adapter: "binance",
      credentialsJson: "{}",
      label: "Binance",
      ownership: [{ memberId: "mJ", shareBps: 10_000 }],
    });

    expect(await store.connectedSources.disconnectOwningSource(sourceId)).toBeNull();
    expect(await store.connectedSources.disconnectOwningSource("unknown")).toBeNull();
    expect(await store.connectedSources.listSources()).toHaveLength(1);
  });
});
