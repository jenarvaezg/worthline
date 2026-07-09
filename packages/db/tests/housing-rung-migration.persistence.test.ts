/**
 * Schema v28 migration (ADR 0022): housing becomes the fifth liquidity rung.
 *
 * A pre-recut (v27) database is seeded with frozen snapshot-holding rows whose
 * housing assets carry the OLD `illiquid` tier (the pre-#267 carve sat housing on
 * illiquid) but already have `counts_as_housing = 1`. After migrating, every row
 * with `counts_as_housing = 1` is relabelled to `liquidity_tier = 'housing'`,
 * while non-housing rows (and liabilities) keep their frozen tier. The snapshot's
 * five frozen FIGURES stay byte-identical — relabelling history must never alter a
 * captured figure (ADR 0008). The live `assets` table needs no migration: the
 * runtime `tierOfAsset` already routes every property instrument to `housing`.
 */

import { openLibsqlClient } from "@db/index";
import { migrate, SCHEMA_VERSION } from "@db/migrate";
import { schemaSql } from "@db/schema-sql";
import type { Client } from "@libsql/client";
import { describe, expect, test } from "vitest";

async function seedV27(): Promise<Client> {
  const client = openLibsqlClient(":memory:");
  await client.executeMultiple(schemaSql);
  // Pretend this database predates the housing-rung recut so migrate() runs only
  // the v28 step.
  await client.execute("PRAGMA user_version = 27");

  await client.executeMultiple(`
    INSERT INTO snapshots
      (id, scope_id, scope_label, captured_at, date_key, month_key, currency,
       total_net_worth_minor, liquid_net_worth_minor, housing_equity_minor,
       gross_assets_minor, debts_minor)
    VALUES
      ('snap1', 'household', 'Casa', '2025-01-01T12:00:00.000Z', '2025-01-01', '2025-01',
       'EUR', 130000, 10000, 120000, 320000, 190000);

    INSERT INTO snapshot_holdings
      (id, snapshot_id, holding_id, kind, label, liquidity_tier, value_minor, counts_as_housing, secures_housing)
    VALUES
      ('sh_home', 'snap1', 'a_home', 'asset', 'Piso', 'illiquid', 300000, 1, 0),
      ('sh_art', 'snap1', 'a_art', 'asset', 'Cuadro', 'illiquid', 10000, 0, 0),
      ('sh_cash', 'snap1', 'a_cash', 'asset', 'Caja', 'cash', 10000, 0, 0),
      ('sh_mortgage', 'snap1', 'l_mortgage', 'liability', 'Hipoteca', 'illiquid', 180000, 0, 1),
      ('sh_loan', 'snap1', 'l_loan', 'liability', 'Préstamo', NULL, 10000, 0, 0);
  `);

  return client;
}

const tierOf = async (client: Client, id: string) =>
  (
    (
      await client.execute({
        sql: "SELECT liquidity_tier AS t FROM snapshot_holdings WHERE id = ?",
        args: [id],
      })
    ).rows[0] as unknown as { t: string | null }
  ).t;

const userVersion = async (client: Client) =>
  Number((await client.execute("PRAGMA user_version")).rows[0]!.user_version);

const FIGURE_COLUMNS = [
  "total_net_worth_minor",
  "liquid_net_worth_minor",
  "housing_equity_minor",
  "gross_assets_minor",
  "debts_minor",
] as const;

describe("housing-rung schema migration (v28)", () => {
  test("relabels every counts_as_housing row to the housing rung", async () => {
    const client = await seedV27();
    await migrate(client);

    // The housing asset moves illiquid → housing.
    expect(await tierOf(client, "sh_home")).toBe("housing");
    // Non-housing rows keep their frozen tier; the null-tier loan stays null.
    expect(await tierOf(client, "sh_art")).toBe("illiquid");
    expect(await tierOf(client, "sh_cash")).toBe("cash");
    expect(await tierOf(client, "sh_mortgage")).toBe("illiquid");
    expect(await tierOf(client, "sh_loan")).toBeNull();
    expect(await userVersion(client)).toBe(SCHEMA_VERSION);
  });

  test("the five frozen figures of an existing snapshot are byte-identical after the recut", async () => {
    const client = await seedV27();
    const select = `SELECT ${FIGURE_COLUMNS.join(", ")} FROM snapshots WHERE id = 'snap1'`;
    const before = (await client.execute(select)).rows[0];

    await migrate(client);

    expect((await client.execute(select)).rows[0]).toEqual(before);
  });

  test("is idempotent on a second run", async () => {
    const client = await seedV27();
    await migrate(client);

    const before = (
      await client.execute("SELECT id, liquidity_tier FROM snapshot_holdings ORDER BY id")
    ).rows;
    await migrate(client); // a second run sits behind `version < 28` → no-op
    expect(await userVersion(client)).toBe(SCHEMA_VERSION);
    expect(
      (
        await client.execute(
          "SELECT id, liquidity_tier FROM snapshot_holdings ORDER BY id",
        )
      ).rows,
    ).toEqual(before);
  });
});
