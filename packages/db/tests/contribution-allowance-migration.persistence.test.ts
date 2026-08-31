/**
 * Schema migration v58 (#1427): the annual contribution allowance tables land on
 * a pre-existing database and on a fresh one built from `schemaSql`, with the
 * same shape in both — the ladder and the fresh schema drifting apart is how a
 * column ends up existing only for new workspaces.
 */
import { openLibsqlClient } from "@db/index";
import { migrate, SCHEMA_VERSION } from "@db/migrate";
import { schemaSql } from "@db/schema-sql";
import type { Client } from "@libsql/client";
import { describe, expect, test } from "vitest";

async function seedV57(): Promise<Client> {
  const client = openLibsqlClient(":memory:");
  await client.execute("CREATE TABLE schema_meta (version INTEGER NOT NULL)");
  await client.execute("INSERT INTO schema_meta (version) VALUES (57)");
  return client;
}

function columnNames(rows: unknown): string[] {
  return (rows as Array<{ name: string }>).map((c) => c.name);
}

describe("schema migration v58 (contribution allowances)", () => {
  test("creates the allowance table and its destination links", async () => {
    const client = await seedV57();

    await migrate(client);

    expect(
      columnNames(
        (await client.execute("PRAGMA table_info(contribution_allowances)")).rows,
      ),
    ).toEqual([
      "id",
      "scope_id",
      "label",
      "annual_cap_minor",
      "created_at",
      "updated_at",
    ]);
    expect(
      columnNames(
        (await client.execute("PRAGMA table_info(contribution_allowance_holdings)")).rows,
      ),
    ).toEqual(["allowance_id", "asset_id"]);
    expect(
      Number((await client.execute("SELECT version FROM schema_meta")).rows[0]!.version),
    ).toBe(SCHEMA_VERSION);
    expect(SCHEMA_VERSION).toBe(69);
  });

  test("stores no consumed total — it is derived from the ledger on every read", async () => {
    const client = await seedV57();

    await migrate(client);

    const cols = columnNames(
      (await client.execute("PRAGMA table_info(contribution_allowances)")).rows,
    );
    expect(cols.some((name) => name.includes("consumed"))).toBe(false);
  });

  test("a second run is a no-op", async () => {
    const client = await seedV57();

    await migrate(client);
    await migrate(client);

    expect(
      Number((await client.execute("SELECT version FROM schema_meta")).rows[0]!.version),
    ).toBe(SCHEMA_VERSION);
  });

  test("fresh schemaSql carries the same tables", async () => {
    const client = openLibsqlClient(":memory:");

    await client.executeMultiple(schemaSql);

    expect(
      columnNames(
        (await client.execute("PRAGMA table_info(contribution_allowances)")).rows,
      ),
    ).toEqual([
      "id",
      "scope_id",
      "label",
      "annual_cap_minor",
      "created_at",
      "updated_at",
    ]);
    expect(
      columnNames(
        (await client.execute("PRAGMA table_info(contribution_allowance_holdings)")).rows,
      ),
    ).toEqual(["allowance_id", "asset_id"]);
  });
});
