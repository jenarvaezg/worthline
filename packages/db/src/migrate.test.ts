/**
 * Migration v60 backfill (#1437): mark which valuation anchor is the
 * acquisition. The rule, in order:
 *  1. an anchor whose id carries the `_acquisition` suffix (the assistant's
 *     creation path has seeded one since PRD #108);
 *  2. otherwise the oldest market appraisal (`adjusts_prior_curve = 1`) of the
 *     asset — a pre-#1437 asset still has its acquisition as its first truth.
 *
 * The fixture builds the schema AS OF v59 (no `kind` column) and pins
 * `user_version` to 59 so only the v60 block runs.
 */

import { describe, expect, test } from "vitest";
import { openLibsqlClient } from "./libsql-client";
import { migrate } from "./migrate";

async function seedV59Database() {
  const client = openLibsqlClient(":memory:");
  await client.executeMultiple(`
    CREATE TABLE assets (
      id TEXT PRIMARY KEY NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL
    );
    CREATE TABLE asset_valuations (
      id TEXT PRIMARY KEY NOT NULL,
      asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
      value_minor INTEGER NOT NULL,
      valuation_date TEXT NOT NULL,
      adjusts_prior_curve INTEGER NOT NULL,
      source TEXT DEFAULT 'manual' NOT NULL,
      batch_id TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL
    );
    CREATE UNIQUE INDEX asset_valuations_asset_date_unique
      ON asset_valuations (asset_id, valuation_date);
    INSERT INTO assets (id) VALUES ('p_con_sufijo'), ('p_sin_sufijo'), ('p_solo_mejoras');
    -- anchor_wl_hld_x_acquisition_1730... is the REAL shape createStableId
    -- mints: the seed lands AFTER the marker, so _acquisition sits inside.
    INSERT INTO asset_valuations (id, asset_id, value_minor, valuation_date, adjusts_prior_curve) VALUES
      ('anchor_wl_hld_x_acquisition_1730000000', 'p_con_sufijo', 15000000, '2004-05-19', 1),
      ('anchor_wl_hld_x_tasacion_1730000100', 'p_con_sufijo', 23300000, '2026-07-09', 1),
      ('b_antigua', 'p_sin_sufijo', 10000000, '2015-03-01', 1),
      ('b_tasacion', 'p_sin_sufijo', 18000000, '2024-09-01', 1),
      ('b_mejora', 'p_sin_sufijo', 500000, '2025-01-01', 0),
      ('m_unica', 'p_solo_mejoras', 300000, '2025-06-01', 0);
  `);
  await client.execute("PRAGMA user_version = 59");
  return client;
}

async function kindOf(client: Awaited<ReturnType<typeof seedV59Database>>, id: string) {
  const result = await client.execute({
    sql: "SELECT kind FROM asset_valuations WHERE id = ?",
    args: [id],
  });
  return (result.rows[0]?.kind as string | undefined) ?? null;
}

describe("migration v60 — acquisition anchor backfill (#1437)", () => {
  test("marks the anchor whose id embeds the _acquisition marker", async () => {
    const client = await seedV59Database();
    await migrate(client);

    expect(await kindOf(client, "anchor_wl_hld_x_acquisition_1730000000")).toBe(
      "acquisition",
    );
    expect(await kindOf(client, "anchor_wl_hld_x_tasacion_1730000100")).toBeNull();
    client.close();
  });

  test("falls back to the oldest market appraisal when no suffix exists", async () => {
    const client = await seedV59Database();
    await migrate(client);

    expect(await kindOf(client, "b_antigua")).toBe("acquisition");
    expect(await kindOf(client, "b_tasacion")).toBeNull();
    expect(await kindOf(client, "b_mejora")).toBeNull();
    client.close();
  });

  test("an asset with only improvements gets no acquisition", async () => {
    const client = await seedV59Database();
    await migrate(client);

    expect(await kindOf(client, "m_unica")).toBeNull();
    client.close();
  });
});
