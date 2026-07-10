import { openLibsqlClient } from "@db/index";
import { migrate, SCHEMA_VERSION } from "@db/migrate";
import { schemaSql } from "@db/schema-sql";
import type { Client } from "@libsql/client";
import { describe, expect, test } from "vitest";

async function seedV44(): Promise<Client> {
  const client = openLibsqlClient(":memory:");
  await client.execute("CREATE TABLE schema_meta (version INTEGER NOT NULL)");
  await client.execute("INSERT INTO schema_meta (version) VALUES (44)");
  return client;
}

function columnNames(rows: unknown): string[] {
  return (rows as Array<{ name: string }>).map((c) => c.name);
}

describe("schema migration v45 (planned_contributions)", () => {
  test("creates the planned_contributions table", async () => {
    const client = await seedV44();

    await migrate(client);

    const cols = columnNames(
      (await client.execute("PRAGMA table_info(planned_contributions)")).rows,
    );
    expect(cols).toEqual([
      "id",
      "scope_id",
      "destination_holding_id",
      "amount_json",
      "cadence_json",
      "start_date",
      "end_date",
      "created_at",
    ]);

    expect(
      Number((await client.execute("SELECT version FROM schema_meta")).rows[0]!.version),
    ).toBe(SCHEMA_VERSION);
    expect(SCHEMA_VERSION).toBe(45);
  });

  test("fresh schemaSql includes planned_contributions", async () => {
    const client = openLibsqlClient(":memory:");

    await client.executeMultiple(schemaSql);

    expect(
      columnNames(
        (await client.execute("PRAGMA table_info(planned_contributions)")).rows,
      ),
    ).toContain("amount_json");
  });
});
