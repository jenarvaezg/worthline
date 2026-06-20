/**
 * Schema v13 migration (ADR 0014, #148): the valuation_method backfill.
 *
 * A database whose holdings predate the v13 backfill (valuation_method NULL) is
 * seeded with one holding of each type / debt model plus a snapshot. After
 * migrating, valuation_method is backfilled from type/debt_model — cash/manual →
 * stored, investment → derived, real_estate → appreciating; amortizable →
 * amortized, revolving/informal → anchored, no model → stored — the snapshot's
 * five frozen figures stay byte-identical (this migration touches no figure), and
 * user_version reaches SCHEMA_VERSION.
 */
import type { Client } from "@libsql/client";
import { describe, expect, test } from "vitest";

import { openLibsqlClient } from "@db/index";
import { migrate, SCHEMA_VERSION } from "@db/migrate";
import { schemaSql } from "@db/schema-sql";

async function seedV12(): Promise<Client> {
  const client = openLibsqlClient(":memory:");
  // Genuinely pre-v13: strip the valuation_method column so migrate() exercises
  // the real legacy-DB path — ALTER TABLE ADD COLUMN then backfill — not merely a
  // backfill of an already-present column.
  await client.executeMultiple(
    schemaSql.replace(/[ \t]*`valuation_method` text,\n/g, ""),
  );
  await client.execute("PRAGMA user_version = 12");

  await client.executeMultiple(`
    INSERT INTO assets (id, name, type, currency, current_value_minor, liquidity_tier) VALUES
      ('a_cash', 'Caja', 'cash', 'EUR', 10000, 'cash'),
      ('a_car', 'Coche', 'manual', 'EUR', 20000, 'illiquid'),
      ('a_fund', 'Fondo', 'investment', 'EUR', 50000, 'market'),
      ('a_home', 'Piso', 'real_estate', 'EUR', 300000, 'illiquid');

    INSERT INTO assets (id, name, type, currency, current_value_minor, liquidity_tier, is_primary_residence) VALUES
      ('a_residence', 'Vivienda', 'manual', 'EUR', 250000, 'illiquid', 1);

    INSERT INTO liabilities (id, name, type, currency, current_balance_minor, debt_model) VALUES
      ('l_mortgage', 'Hipoteca', 'mortgage', 'EUR', 200000, 'amortizable'),
      ('l_card', 'Tarjeta', 'debt', 'EUR', 1500, 'revolving'),
      ('l_friend', 'Amigo', 'debt', 'EUR', 3000, 'informal'),
      ('l_plain', 'Suelta', 'debt', 'EUR', 500, NULL);

    INSERT INTO snapshots
      (id, scope_id, scope_label, captured_at, date_key, month_key, currency,
       total_net_worth_minor, liquid_net_worth_minor, housing_equity_minor,
       gross_assets_minor, debts_minor)
    VALUES
      ('snap1', 'household', 'Casa', '2025-01-01T12:00:00.000Z', '2025-01-01', '2025-01',
       'EUR', 180000, 9000, 120000, 390000, 210000);
  `);

  return client;
}

const assetMethod = async (client: Client, id: string) =>
  (
    (
      await client.execute({
        sql: "SELECT valuation_method AS m FROM assets WHERE id = ?",
        args: [id],
      })
    ).rows[0] as unknown as {
      m: string | null;
    }
  ).m;

const liabilityMethod = async (client: Client, id: string) =>
  (
    (
      await client.execute({
        sql: "SELECT valuation_method AS m FROM liabilities WHERE id = ?",
        args: [id],
      })
    ).rows[0] as unknown as {
      m: string | null;
    }
  ).m;

describe("valuation-method schema migration (v13)", () => {
  test("backfills asset valuation_method from type", async () => {
    const client = await seedV12();
    await migrate(client);

    expect(await assetMethod(client, "a_cash")).toBe("stored");
    expect(await assetMethod(client, "a_car")).toBe("stored");
    expect(await assetMethod(client, "a_fund")).toBe("derived");
    expect(await assetMethod(client, "a_home")).toBe("appreciating");
    // A primary residence is appreciating even when its type isn't real_estate —
    // the backfill mirrors the runtime isHousingAsset boundary.
    expect(await assetMethod(client, "a_residence")).toBe("appreciating");
    expect(
      Number((await client.execute("PRAGMA user_version")).rows[0]!.user_version),
    ).toBe(SCHEMA_VERSION);
  });

  test("backfills liability valuation_method from debt_model (no model → stored)", async () => {
    const client = await seedV12();
    await migrate(client);

    expect(await liabilityMethod(client, "l_mortgage")).toBe("amortized");
    expect(await liabilityMethod(client, "l_card")).toBe("anchored");
    expect(await liabilityMethod(client, "l_friend")).toBe("anchored");
    expect(await liabilityMethod(client, "l_plain")).toBe("stored");
  });

  test("touches no frozen snapshot figure", async () => {
    const client = await seedV12();
    const select =
      "SELECT total_net_worth_minor, liquid_net_worth_minor, housing_equity_minor, " +
      "gross_assets_minor, debts_minor FROM snapshots WHERE id = 'snap1'";
    const before = (await client.execute(select)).rows[0];

    await migrate(client);

    expect((await client.execute(select)).rows[0]).toEqual(before);
  });

  test("adds the valuation_method column to both tables (the legacy ALTER path)", async () => {
    const client = await seedV12();
    const hasColumn = async (table: string) =>
      (
        (await client.execute(`PRAGMA table_info(${table})`)).rows as unknown as Array<{
          name: string;
        }>
      ).some((c) => c.name === "valuation_method");

    expect(await hasColumn("assets")).toBe(false); // genuinely pre-v13: column absent
    await migrate(client);
    expect(await hasColumn("assets")).toBe(true);
    expect(await hasColumn("liabilities")).toBe(true);
  });

  test("leaves no holding null and is idempotent on a second run", async () => {
    const client = await seedV12();
    await migrate(client);

    const nullCount = async () =>
      Number(
        (
          await client.execute(
            "SELECT (SELECT COUNT(*) FROM assets WHERE valuation_method IS NULL) + " +
              "(SELECT COUNT(*) FROM liabilities WHERE valuation_method IS NULL) AS n",
          )
        ).rows[0]!.n,
      );

    expect(await nullCount()).toBe(0);

    const before = (
      await client.execute("SELECT id, valuation_method FROM assets ORDER BY id")
    ).rows;
    await migrate(client); // a second run sits behind `version < 13` → no-op
    expect(
      Number((await client.execute("PRAGMA user_version")).rows[0]!.user_version),
    ).toBe(SCHEMA_VERSION);
    expect(
      (await client.execute("SELECT id, valuation_method FROM assets ORDER BY id")).rows,
    ).toEqual(before);
  });
});
