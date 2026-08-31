import { openLibsqlClient } from "@db/index";
import { migrate, SCHEMA_VERSION } from "@db/migrate";
import type { Client } from "@libsql/client";
import { describe, expect, test } from "vitest";

/**
 * v53 (#1245, PRD #1241): `early_repayments.source` — the sibling of
 * `asset_valuations.source` (v49) and `liability_balance_rebaselines.source`
 * (v48). Without it an early repayment written by the assistant is
 * indistinguishable from one typed by hand in `/patrimonio/[id]/editar`.
 *
 * Seeded at v52 without the column so the test exercises the real legacy-DB path
 * (ALTER TABLE ADD COLUMN with a `manual` default), not merely a version bump.
 */
async function seedV52(): Promise<Client> {
  const client = openLibsqlClient(":memory:");
  await client.execute("CREATE TABLE schema_meta (version INTEGER NOT NULL)");
  await client.execute("INSERT INTO schema_meta (version) VALUES (52)");
  await client.executeMultiple(`
    CREATE TABLE early_repayments (
      id TEXT PRIMARY KEY NOT NULL,
      plan_id TEXT NOT NULL,
      repayment_date TEXT NOT NULL,
      amount_minor INTEGER NOT NULL,
      mode TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL
    );
    INSERT INTO early_repayments (id, plan_id, repayment_date, amount_minor, mode) VALUES
      ('r_manual', 'plan1', '2026-05-15', 9132, 'reduce-term');
  `);
  return client;
}

describe("schema migration v53 (early repayment source)", () => {
  test("adds source defaulting existing repayments to manual", async () => {
    const client = await seedV52();

    await migrate(client);

    expect(
      (await client.execute("SELECT id, source FROM early_repayments")).rows,
    ).toEqual([{ id: "r_manual", source: "manual" }]);
    expect(
      Number((await client.execute("SELECT version FROM schema_meta")).rows[0]!.version),
    ).toBe(SCHEMA_VERSION);
    expect(SCHEMA_VERSION).toBe(66);
  });

  test("is idempotent over a DB that already carries the column", async () => {
    const client = await seedV52();
    await migrate(client);

    // A second pass must not double-add the column nor throw.
    await migrate(client);

    const columns = await client.execute("PRAGMA table_info(early_repayments)");
    expect(columns.rows.filter((row) => row.name === "source")).toHaveLength(1);
  });
});
