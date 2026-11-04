/**
 * Schema migration v76 (#1881, ADR 0115 decision 6, ADR 0062): the manual operations
 * a source replaces when it is linked to a holding that existed by hand, kept as the
 * linking batch's provenance in `fact_batch_replaced_operations`.
 *
 * Additive: nothing existing changes, and a re-run changes nothing.
 */
import { openLibsqlClient } from "@db/index";
import { migrate, SCHEMA_VERSION } from "@db/migrate";
import { schemaSql } from "@db/schema-sql";
import type { Client } from "@libsql/client";
import { describe, expect, test } from "vitest";

const TABLE = "fact_batch_replaced_operations";

/** Today's schema rolled back to v75: without the provenance table. */
function schemaAtV75(): string {
  return schemaSql
    .split("--> statement-breakpoint")
    .filter((statement) => !statement.includes(TABLE))
    .join("--> statement-breakpoint");
}

async function seedAtV75(): Promise<Client> {
  const client = openLibsqlClient(":memory:");
  await client.executeMultiple(schemaAtV75());
  await client.execute("CREATE TABLE schema_meta (version INTEGER NOT NULL)");
  await client.execute("INSERT INTO schema_meta (version) VALUES (75)");
  await client.execute(
    `INSERT INTO assets (id, name, type, currency, current_value_minor, liquidity_tier)
     VALUES ('hand', 'A mano', 'investment', 'EUR', 0, 'market')`,
  );
  return client;
}

async function tables(client: Client): Promise<string[]> {
  return (
    await client.execute("SELECT name FROM sqlite_master WHERE type = 'table'")
  ).rows.map((row) => String(row.name));
}

describe("schema migration v76 (the provenance of a link's replaced operations)", () => {
  test("adds the table, hung on the holding and on nothing else", async () => {
    const client = await seedAtV75();
    expect(await tables(client)).not.toContain(TABLE);

    await migrate(client);

    expect(SCHEMA_VERSION).toBe(77);
    expect(await tables(client)).toContain(TABLE);
    // The batch is not a parent: a document restores provenance without batches.
    await client.execute(
      `INSERT INTO ${TABLE} (operation_id, batch_id, asset_id, operation_json)
       VALUES ('m1', 'no-such-batch', 'hand', '{}')`,
    );
    // The holding is: deleting it takes its provenance along.
    await client.execute("PRAGMA foreign_keys = ON");
    await client.execute("DELETE FROM assets WHERE id = 'hand'");
    expect((await client.execute(`SELECT * FROM ${TABLE}`)).rows).toEqual([]);
  });

  test("re-running the rung on a migrated database changes nothing", async () => {
    const client = await seedAtV75();
    await migrate(client);
    await client.execute(
      `INSERT INTO ${TABLE} (operation_id, batch_id, asset_id, operation_json)
       VALUES ('m1', 'b1', 'hand', '{}')`,
    );
    await client.execute("UPDATE schema_meta SET version = 75");

    await migrate(client);

    expect((await client.execute(`SELECT * FROM ${TABLE}`)).rows).toHaveLength(1);
  });
});
