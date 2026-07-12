import { openLibsqlClient } from "@db/index";
import { migrate, SCHEMA_VERSION } from "@db/migrate";
import { schemaSql } from "@db/schema-sql";
import type { Client } from "@libsql/client";
import { describe, expect, test } from "vitest";

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

async function seedV40WithExposureProfile(): Promise<Client> {
  const client = openLibsqlClient(":memory:");
  await client.execute("CREATE TABLE schema_meta (version INTEGER NOT NULL)");
  await client.execute("INSERT INTO schema_meta (version) VALUES (40)");
  await client.executeMultiple(`CREATE TABLE exposure_profiles (
    key TEXT PRIMARY KEY NOT NULL,
    tracked_index TEXT,
    ter TEXT,
    hedged INTEGER DEFAULT 0 NOT NULL,
    breakdowns_json TEXT DEFAULT '{}' NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL
  );`);
  await client.execute("INSERT INTO exposure_profiles (key) VALUES ('IE00SP500')");
  return client;
}

describe("schema migrations v38/v41", () => {
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
      "source",
      "declared_at",
    ]);
    expect(columns.find((column) => column.name === "hedged")).toMatchObject({
      dflt_value: "0",
      notnull: 1,
    });
    expect(columns.find((column) => column.name === "source")).toMatchObject({
      dflt_value: "'user'",
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
          "SELECT source, declared_at, hedged, breakdowns_json FROM exposure_profiles WHERE key = 'IE00SP500'",
        )
      ).rows[0],
    ).toMatchObject({
      breakdowns_json: "{}",
      declared_at: null,
      hedged: 0,
      source: "user",
    });
    expect(
      Number((await client.execute("SELECT version FROM schema_meta")).rows[0]!.version),
    ).toBe(SCHEMA_VERSION);
    expect(
      Number((await client.execute("PRAGMA user_version")).rows[0]!.user_version),
    ).toBe(SCHEMA_VERSION);

    await migrate(client);
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(41);
  });

  test("fresh schemaSql includes the exposure_profiles table", async () => {
    const client = openLibsqlClient(":memory:");

    await client.executeMultiple(schemaSql);
    await client.execute("INSERT INTO exposure_profiles (key) VALUES ('N5394')");

    expect(
      (
        await client.execute(
          "SELECT source, declared_at, hedged, breakdowns_json FROM exposure_profiles WHERE key = 'N5394'",
        )
      ).rows[0],
    ).toMatchObject({
      breakdowns_json: "{}",
      declared_at: null,
      hedged: 0,
      source: "user",
    });
  });

  test("adds provenance columns to existing exposure profile rows", async () => {
    const client = await seedV40WithExposureProfile();

    await migrate(client);

    expect(
      (
        await client.execute(
          "SELECT source, declared_at FROM exposure_profiles WHERE key = 'IE00SP500'",
        )
      ).rows[0],
    ).toMatchObject({ declared_at: null, source: "user" });
    expect(
      Number((await client.execute("SELECT version FROM schema_meta")).rows[0]!.version),
    ).toBe(SCHEMA_VERSION);
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
      "source",
    ]);
    expect(
      Number((await client.execute("SELECT version FROM schema_meta")).rows[0]!.version),
    ).toBe(SCHEMA_VERSION);
  });
});

async function seedV39(): Promise<Client> {
  const client = openLibsqlClient(":memory:");
  await client.execute("CREATE TABLE schema_meta (version INTEGER NOT NULL)");
  await client.execute("INSERT INTO schema_meta (version) VALUES (39)");
  return client;
}

describe("schema migrations v40", () => {
  test("adds original_signing_date to amortization_plans on an existing DB", async () => {
    const client = await seedV39();
    // v40 ALTERs an existing amortization_plans table — v39 alone has no such
    // table yet, so create the pre-v40 shape (matching the v2 bootstrap) first.
    await client.execute(`CREATE TABLE amortization_plans (
      id TEXT PRIMARY KEY NOT NULL,
      liability_id TEXT NOT NULL,
      initial_capital_minor INTEGER NOT NULL,
      annual_interest_rate TEXT NOT NULL,
      term_months INTEGER NOT NULL,
      disbursement_date TEXT NOT NULL,
      first_payment_date TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL
    )`);

    await migrate(client);

    const columns = (await client.execute("PRAGMA table_info(amortization_plans)"))
      .rows as unknown as Array<{ name: string; notnull: number }>;
    expect(columns.map((column) => column.name)).toContain("original_signing_date");
    expect(
      columns.find((column) => column.name === "original_signing_date"),
    ).toMatchObject({ notnull: 0 });
    expect(
      Number((await client.execute("SELECT version FROM schema_meta")).rows[0]!.version),
    ).toBe(SCHEMA_VERSION);
  });

  test("fresh schemaSql already carries original_signing_date on amortization_plans", async () => {
    const client = openLibsqlClient(":memory:");

    await client.executeMultiple(schemaSql);
    await client.execute(`INSERT INTO liabilities
      (id, name, type, currency, current_balance_minor)
      VALUES ('l1', 'Hipoteca', 'mortgage', 'EUR', 20000000)`);
    await client.execute({
      sql: `INSERT INTO amortization_plans
        (id, liability_id, initial_capital_minor, annual_interest_rate, term_months,
         disbursement_date, first_payment_date, original_signing_date)
        VALUES ('plan1', 'l1', 20000000, '0.025', 240, '2026-07-02', '2026-08-01', '2004-03-01')`,
      args: [],
    });

    expect(
      (
        await client.execute(
          "SELECT original_signing_date FROM amortization_plans WHERE id = 'plan1'",
        )
      ).rows[0],
    ).toMatchObject({ original_signing_date: "2004-03-01" });
  });
});
