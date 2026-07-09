/**
 * Schema v12 migration (ADR 0013): the liquidity-ladder recut.
 *
 * A pre-recut (v11) database is seeded with `retirement`/`housing` tiers on both
 * live assets and frozen snapshot-holding rows, plus a snapshot carrying its five
 * frozen figures. After migrating: the tiers are remapped (retirement → term-locked,
 * housing → illiquid) on both, while the snapshot's five frozen figures stay
 * byte-identical — re-tiering history must never alter a captured figure (ADR 0008).
 */

import { openLibsqlClient } from "@db/index";
import { migrate, SCHEMA_VERSION } from "@db/migrate";
import { schemaSql } from "@db/schema-sql";
import type { Client } from "@libsql/client";
import { describe, expect, test } from "vitest";

async function seedV11(): Promise<Client> {
  const client = openLibsqlClient(":memory:");
  await client.executeMultiple(schemaSql);
  // Pretend this database predates the recut so migrate() runs only the v12 step.
  await client.execute("PRAGMA user_version = 11");

  await client.executeMultiple(`
    INSERT INTO assets (id, name, type, currency, current_value_minor, liquidity_tier) VALUES
      ('a_pension', 'Plan', 'manual', 'EUR', 80000, 'retirement'),
      ('a_home', 'Piso', 'real_estate', 'EUR', 300000, 'housing'),
      ('a_cash', 'Caja', 'cash', 'EUR', 10000, 'cash');

    INSERT INTO snapshots
      (id, scope_id, scope_label, captured_at, date_key, month_key, currency,
       total_net_worth_minor, liquid_net_worth_minor, housing_equity_minor,
       gross_assets_minor, debts_minor)
    VALUES
      ('snap1', 'household', 'Casa', '2025-01-01T12:00:00.000Z', '2025-01-01', '2025-01',
       'EUR', 180000, 9000, 120000, 390000, 210000);

    INSERT INTO snapshot_holdings (id, snapshot_id, holding_id, kind, label, liquidity_tier, value_minor) VALUES
      ('sh_pension', 'snap1', 'a_pension', 'asset', 'Plan', 'retirement', 80000),
      ('sh_home', 'snap1', 'a_home', 'asset', 'Piso', 'housing', 300000),
      ('sh_cash', 'snap1', 'a_cash', 'asset', 'Caja', 'cash', 10000),
      ('sh_loan', 'snap1', 'l_loan', 'liability', 'Préstamo', NULL, 30000);
  `);

  return client;
}

const FIGURE_COLUMNS = [
  "total_net_worth_minor",
  "liquid_net_worth_minor",
  "housing_equity_minor",
  "gross_assets_minor",
  "debts_minor",
] as const;

describe("liquidity-ladder schema migration (v12)", () => {
  test("remaps live asset tiers retirement → term-locked and housing → illiquid", async () => {
    const client = await seedV11();
    await migrate(client);

    const tierOf = async (id: string) =>
      (
        (
          await client.execute({
            sql: "SELECT liquidity_tier AS t FROM assets WHERE id = ?",
            args: [id],
          })
        ).rows[0] as unknown as { t: string }
      ).t;

    expect(await tierOf("a_pension")).toBe("term-locked");
    expect(await tierOf("a_home")).toBe("illiquid");
    expect(await tierOf("a_cash")).toBe("cash");
    expect(
      Number((await client.execute("PRAGMA user_version")).rows[0]!.user_version),
    ).toBe(SCHEMA_VERSION);
  });

  test("remaps frozen snapshot-holding tiers, leaving null tiers untouched", async () => {
    const client = await seedV11();
    await migrate(client);

    const tierOf = async (id: string) =>
      (
        (
          await client.execute({
            sql: "SELECT liquidity_tier AS t FROM snapshot_holdings WHERE id = ?",
            args: [id],
          })
        ).rows[0] as unknown as { t: string | null }
      ).t;

    expect(await tierOf("sh_pension")).toBe("term-locked");
    // Migrate runs the FULL ladder: v12 recuts housing → illiquid, then v17
    // backfills counts_as_housing=1 for this property row, and v28 (ADR 0022)
    // relabels every counts_as_housing row to the new `housing` rung.
    expect(await tierOf("sh_home")).toBe("housing");
    expect(await tierOf("sh_cash")).toBe("cash");
    expect(await tierOf("sh_loan")).toBeNull();
  });

  test("the five frozen figures of an existing snapshot are byte-identical after the recut", async () => {
    const client = await seedV11();
    const select = `SELECT ${FIGURE_COLUMNS.join(", ")} FROM snapshots WHERE id = 'snap1'`;
    const before = (await client.execute(select)).rows[0];

    await migrate(client);

    const after = (await client.execute(select)).rows[0];
    expect(after).toEqual(before);
    // And concretely, the seeded values are intact.
    expect(after).toEqual({
      total_net_worth_minor: 180000,
      liquid_net_worth_minor: 9000,
      housing_equity_minor: 120000,
      gross_assets_minor: 390000,
      debts_minor: 210000,
    });
  });
});
