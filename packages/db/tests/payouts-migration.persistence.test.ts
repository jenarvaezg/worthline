import type { Client } from "@libsql/client";
import { describe, expect, test } from "vitest";

import { openLibsqlClient } from "@db/index";
import { migrate, SCHEMA_VERSION } from "@db/migrate";
import { schemaSql } from "@db/schema-sql";

async function seedV41(): Promise<Client> {
  const client = openLibsqlClient(":memory:");
  await client.execute("CREATE TABLE schema_meta (version INTEGER NOT NULL)");
  await client.execute("INSERT INTO schema_meta (version) VALUES (41)");
  return client;
}

function columnNames(rows: unknown): string[] {
  return (rows as Array<{ name: string }>).map((c) => c.name);
}

describe("schema migration v42 (payouts)", () => {
  test("creates the payouts and payout_schedules tables", async () => {
    const client = await seedV41();

    await migrate(client);

    const payoutCols = columnNames(
      (await client.execute("PRAGMA table_info(payouts)")).rows,
    );
    expect(payoutCols).toEqual([
      "id",
      "holding_id",
      "date",
      "amount_minor",
      "note",
      "created_at",
    ]);

    const scheduleCols = columnNames(
      (await client.execute("PRAGMA table_info(payout_schedules)")).rows,
    );
    expect(scheduleCols).toEqual([
      "id",
      "holding_id",
      "label",
      "amount_minor",
      "cadence",
      "start_date",
      "end_date",
      "exclusions_json",
      "created_at",
    ]);

    expect(
      Number((await client.execute("SELECT version FROM schema_meta")).rows[0]!.version),
    ).toBe(SCHEMA_VERSION);
    expect(SCHEMA_VERSION).toBe(43);
  });

  test("fresh schemaSql includes both payout tables", async () => {
    const client = openLibsqlClient(":memory:");

    await client.executeMultiple(schemaSql);

    expect(
      columnNames((await client.execute("PRAGMA table_info(payouts)")).rows),
    ).toContain("amount_minor");
    expect(
      columnNames((await client.execute("PRAGMA table_info(payout_schedules)")).rows),
    ).toContain("exclusions_json");
  });
});
