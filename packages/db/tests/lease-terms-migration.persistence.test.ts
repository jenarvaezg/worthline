import { openLibsqlClient } from "@db/index";
import { migrate, SCHEMA_VERSION } from "@db/migrate";
import { schemaSql } from "@db/schema-sql";
import type { Client } from "@libsql/client";
import { describe, expect, test } from "vitest";

/**
 * v66 (#1521): the lease terms on `payout_schedules` — `lease_regime`,
 * `rent_revision`, `rent_revision_reference` and `post_mandatory_term_policy`.
 *
 * Until v66 an `end_date` in the past was the whole answer: past it the flat went
 * back to the housing rung's guessed 3 % for ever, i.e. `stop` assumed in silence.
 * That assumption is not neutral — a long-term residential lease continues past its
 * signed date by law — so the four columns let the owner say what the date means and
 * what he will do once the decision is his again.
 *
 * NOTHING is backfilled, and that is the load-bearing part (ADR 0074, ADR 0076
 * point 2): NULL reads as «nadie lo ha dicho» and the engine keeps behaving exactly
 * as it did before. Guessing a regime off the label or the length of the window
 * would seal the invention this migration exists to remove, and it would move a FIRE
 * date while doing it.
 *
 * Seeded at v65 with a rent already in the table, so the test travels the real legacy
 * path (an additive ALTER over populated rows), not a fresh create.
 */
async function seedV65(): Promise<Client> {
  const client = openLibsqlClient(":memory:");
  await client.execute("CREATE TABLE schema_meta (version INTEGER NOT NULL)");
  await client.execute("INSERT INTO schema_meta (version) VALUES (65)");
  await client.executeMultiple(`
    CREATE TABLE payout_schedules (
      id TEXT PRIMARY KEY NOT NULL,
      holding_id TEXT NOT NULL,
      label TEXT NOT NULL,
      amount_minor INTEGER NOT NULL,
      expenses_minor INTEGER,
      cadence TEXT NOT NULL,
      start_date TEXT NOT NULL,
      end_date TEXT,
      exclusions_json TEXT DEFAULT '[]' NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL
    );
    INSERT INTO payout_schedules
      (id, holding_id, label, amount_minor, expenses_minor, cadence, start_date, end_date)
    VALUES
      ('s_navalcarnero', 'a_piso', 'Alquiler', 65000, 15000, 'monthly', '2024-01-01', '2026-09-01');
  `);
  return client;
}

describe("schema migration v66 (lease terms)", () => {
  test("adds the four columns unset, leaving the declared rent and its window intact", async () => {
    const client = await seedV65();

    await migrate(client);

    expect(
      (
        await client.execute(
          `SELECT id, amount_minor, expenses_minor, end_date, lease_regime, rent_revision,
                  rent_revision_reference, post_mandatory_term_policy
             FROM payout_schedules`,
        )
      ).rows,
    ).toEqual([
      {
        id: "s_navalcarnero",
        amount_minor: 65_000,
        expenses_minor: 15_000,
        // The window is untouched: this migration decides what the date MEANS, and
        // materializes nothing (ADR 0054 point 4).
        end_date: "2026-09-01",
        lease_regime: null,
        rent_revision: null,
        rent_revision_reference: null,
        post_mandatory_term_policy: null,
      },
    ]);
    expect(
      Number((await client.execute("SELECT version FROM schema_meta")).rows[0]!.version),
    ).toBe(SCHEMA_VERSION);
    expect(SCHEMA_VERSION).toBe(66);
  });

  test("is idempotent over a DB that already carries the columns", async () => {
    const client = await seedV65();
    await migrate(client);

    await migrate(client);

    const columns = await client.execute("PRAGMA table_info(payout_schedules)");
    const names = (columns.rows as unknown as Array<{ name: string }>).map(
      (row) => row.name,
    );
    for (const column of [
      "lease_regime",
      "rent_revision",
      "rent_revision_reference",
      "post_mandatory_term_policy",
    ]) {
      expect(names.filter((name) => name === column)).toHaveLength(1);
    }
  });

  test("a fresh schemaSql carries the four columns too, all nullable", async () => {
    const client = openLibsqlClient(":memory:");

    await client.executeMultiple(schemaSql);

    const columns = await client.execute("PRAGMA table_info(payout_schedules)");
    const rows = columns.rows as unknown as Array<{ name: string; notnull: number }>;
    for (const column of [
      "lease_regime",
      "rent_revision",
      "rent_revision_reference",
      "post_mandatory_term_policy",
    ]) {
      expect(rows.find((row) => row.name === column)).toMatchObject({ notnull: 0 });
    }
  });
});
