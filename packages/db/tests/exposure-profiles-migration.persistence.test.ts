import type { Client } from "@libsql/client";
import { describe, expect, test } from "vitest";

import { openLibsqlClient } from "@db/index";
import { migrate, SCHEMA_VERSION } from "@db/migrate";
import { schemaSql } from "@db/schema-sql";

async function seedV37(): Promise<Client> {
  const client = openLibsqlClient(":memory:");
  await client.execute("CREATE TABLE schema_meta (version INTEGER NOT NULL)");
  await client.execute("INSERT INTO schema_meta (version) VALUES (37)");
  return client;
}

async function seedV38(): Promise<Client> {
  const client = openLibsqlClient(":memory:");
  await client.execute("CREATE TABLE schema_meta (version INTEGER NOT NULL)");
  await client.execute("INSERT INTO schema_meta (version) VALUES (38)");
  return client;
}

describe("schema migrations v38/v39", () => {
  test("creates the exposure_profiles table with JSON breakdown defaults", async () => {
    const client = await seedV37();

    await migrate(client);

    const columns = (await client.execute("PRAGMA table_info(exposure_profiles)"))
      .rows as unknown as Array<{
      name: string;
      notnull: number;
      dflt_value: string | null;
    }>;
    expect(columns.map((column) => column.name)).toEqual([
      "key",
      "tracked_index",
      "ter",
      "hedged",
      "breakdowns_json",
      "created_at",
      "updated_at",
    ]);
    expect(columns.find((column) => column.name === "hedged")).toMatchObject({
      dflt_value: "0",
      notnull: 1,
    });
    expect(columns.find((column) => column.name === "breakdowns_json")).toMatchObject({
      dflt_value: "'{}'",
      notnull: 1,
    });

    await client.execute("INSERT INTO exposure_profiles (key) VALUES ('IE00SP500')");
    expect(
      (
        await client.execute(
          "SELECT hedged, breakdowns_json FROM exposure_profiles WHERE key = 'IE00SP500'",
        )
      ).rows[0],
    ).toMatchObject({ breakdowns_json: "{}", hedged: 0 });
    expect(
      Number((await client.execute("SELECT version FROM schema_meta")).rows[0]!.version),
    ).toBe(SCHEMA_VERSION);
    expect(
      Number((await client.execute("PRAGMA user_version")).rows[0]!.user_version),
    ).toBe(SCHEMA_VERSION);

    await migrate(client);
    expect(SCHEMA_VERSION).toBe(39);
  });

  test("fresh schemaSql includes the exposure_profiles table", async () => {
    const client = openLibsqlClient(":memory:");

    await client.executeMultiple(schemaSql);
    await client.execute("INSERT INTO exposure_profiles (key) VALUES ('N5394')");

    expect(
      (
        await client.execute(
          "SELECT hedged, breakdowns_json FROM exposure_profiles WHERE key = 'N5394'",
        )
      ).rows[0],
    ).toMatchObject({ breakdowns_json: "{}", hedged: 0 });
  });

  test("creates the liability balance re-baselines table", async () => {
    const client = await seedV38();

    await migrate(client);

    const columns = (
      await client.execute("PRAGMA table_info(liability_balance_rebaselines)")
    ).rows as unknown as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toEqual([
      "id",
      "liability_id",
      "baseline_date",
      "outstanding_balance_minor",
      "end_date",
      "next_payment_date",
      "annual_interest_rate",
      "monthly_payment_minor",
      "input_mode",
      "starts_at_baseline",
      "created_at",
    ]);
    expect(
      Number((await client.execute("SELECT version FROM schema_meta")).rows[0]!.version),
    ).toBe(SCHEMA_VERSION);
  });
});
