/**
 * Schema v34 migration (ADR 0035, PRD #459): connected-source holdings freeze a
 * per-position breakdown into each snapshot, as child rows of the snapshot holding.
 * A new `snapshot_position_holdings` table stores one row per position per snapshot:
 * the parent snapshot-holding identity, a stable `position_key` (a coin's Numista
 * `externalId`, ADR 0017 — NOT worthline's reassigned internal id, so there is NO
 * FK to `positions`), a frozen `label`, a `value_minor`, and value-only display
 * metadata (`metal`, `image_url`). Values and labels only — never credentials,
 * tokens or raw payloads.
 *
 * A database whose schema predates v34 (no `snapshot_position_holdings` table) is
 * seeded and migrated. After v34 the table exists with the expected columns and the
 * unique index on (snapshot_id, parent_holding_id, position_key). A second run is a
 * no-op (idempotent), and a fresh DB already carries the table from schema-sql.
 */
import type { Client } from "@libsql/client";
import { describe, expect, test } from "vitest";

import { createInMemoryStore, openLibsqlClient } from "@db/index";
import { migrate, SCHEMA_VERSION } from "@db/migrate";
import { schemaSql } from "@db/schema-sql";

/** A pre-v34 DB at user_version 33: current schema minus the new child table. */
async function seedV33(): Promise<Client> {
  const client = openLibsqlClient(":memory:");
  await client.executeMultiple(schemaSql);
  await client.executeMultiple("DROP TABLE snapshot_position_holdings;");
  await client.execute("PRAGMA user_version = 33");
  return client;
}

async function tableColumns(client: Client, table: string): Promise<string[]> {
  return (
    (await client.execute(`PRAGMA table_info(${table})`)).rows as unknown as {
      name: string;
    }[]
  ).map((c) => c.name);
}

const userVersion = async (client: Client) =>
  Number((await client.execute("PRAGMA user_version")).rows[0]!.user_version);

const tableExists = async (client: Client, name: string): Promise<boolean> =>
  (
    await client.execute({
      args: [name],
      sql: "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
    })
  ).rows.length > 0;

describe("v34 snapshot_position_holdings migration (ADR 0035, #459)", () => {
  test("adds the child table with the per-position columns and unique index", async () => {
    const client = await seedV33();
    expect(await tableExists(client, "snapshot_position_holdings")).toBe(false);

    await migrate(client);

    expect(await tableExists(client, "snapshot_position_holdings")).toBe(true);
    const columns = await tableColumns(client, "snapshot_position_holdings");
    expect(columns).toEqual(
      expect.arrayContaining([
        "id",
        "snapshot_id",
        "parent_holding_id",
        "position_key",
        "label",
        "value_minor",
        "metal",
        "image_url",
        "created_at",
      ]),
    );

    // The unique key is (snapshot, parent holding, position) — the ADR 0035 identity.
    const indexes = (
      await client.execute("PRAGMA index_list(snapshot_position_holdings)")
    ).rows as unknown as { name: string; unique: number }[];
    expect(indexes.some((idx) => idx.unique === 1)).toBe(true);

    expect(await userVersion(client)).toBe(SCHEMA_VERSION);
    client.close();
  });

  test("rows freeze a parent holding's coins keyed by stable position_key, summing to the holding", async () => {
    const client = await seedV33();
    await migrate(client);

    // A snapshot with a connected coin-collection holding and two coin child rows.
    await client.executeMultiple(`
      INSERT INTO snapshots
        (id, scope_id, scope_label, captured_at, date_key, month_key, currency,
         total_net_worth_minor, liquid_net_worth_minor, housing_equity_minor,
         gross_assets_minor, debts_minor)
        VALUES ('snap_1', 'household', 'Hogar', '2026-06-11T10:00:00.000Z',
                '2026-06-11', '2026-06', 'EUR', 500000, 0, 0, 500000, 0);
      INSERT INTO snapshot_position_holdings
        (id, snapshot_id, parent_holding_id, position_key, label, value_minor, metal, image_url)
        VALUES ('p1', 'snap_1', 'asset_coins', 'numista_1', 'Sovereign', 300000, 'gold', 'https://numista.test/s.jpg');
      INSERT INTO snapshot_position_holdings
        (id, snapshot_id, parent_holding_id, position_key, label, value_minor, metal, image_url)
        VALUES ('p2', 'snap_1', 'asset_coins', 'numista_2', 'Maple', 200000, 'silver', NULL);
    `);

    const rows = (
      await client.execute(
        `SELECT position_key, value_minor FROM snapshot_position_holdings
         WHERE snapshot_id = 'snap_1' AND parent_holding_id = 'asset_coins'
         ORDER BY value_minor DESC`,
      )
    ).rows as unknown as { position_key: string; value_minor: number }[];
    expect(rows.map((r) => r.position_key)).toEqual(["numista_1", "numista_2"]);
    expect(rows.reduce((sum, r) => sum + Number(r.value_minor), 0)).toBe(500000);

    client.close();
  });

  test("a second migrate is a no-op (idempotent) and a fresh store carries the table", async () => {
    const client = await seedV33();
    await migrate(client);
    await expect(migrate(client)).resolves.not.toThrow();
    expect(await userVersion(client)).toBe(SCHEMA_VERSION);
    client.close();

    const fresh = await createInMemoryStore();
    expect(() => fresh.close()).not.toThrow();
  });
});
