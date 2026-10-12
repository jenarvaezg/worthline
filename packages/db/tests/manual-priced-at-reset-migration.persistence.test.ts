/**
 * Schema migration v73 (#1731 review): every hand-set price stamp from before it is
 * cleared.
 *
 * Until #1828 `manual_priced_at` was written once, at the alta, and never again — so
 * a stamp already in a database may be the day the holding was created rather than
 * the day its price was typed, and the ficha would print «precio a mano · <alta>»
 * beside a price set months later. Which stamps are honest cannot be told apart, so
 * the rung clears them all: the header then says «precio a mano» with no day until
 * the next price change stamps one. Nothing else in the row moves.
 *
 * It is its own rung after #1812's v72, so a database that already took that one —
 * deployed before this — still runs it.
 */
import { openLibsqlClient } from "@db/index";
import { migrate, SCHEMA_VERSION } from "@db/migrate";
import { schemaSql } from "@db/schema-sql";
import type { Client } from "@libsql/client";
import { describe, expect, test } from "vitest";

/** A database at `version` holding one fund priced by hand, stamped by its alta. */
async function seedAt(version: number): Promise<Client> {
  const client = openLibsqlClient(":memory:");
  await client.executeMultiple(schemaSql);
  await client.execute("CREATE TABLE schema_meta (version INTEGER NOT NULL)");
  await client.execute({
    sql: "INSERT INTO schema_meta (version) VALUES (?)",
    args: [version],
  });
  await client.execute(
    `INSERT INTO assets (id, name, type, currency, current_value_minor, liquidity_tier)
     VALUES ('fund', 'Fondo', 'investment', 'EUR', 0, 'market')`,
  );
  await client.execute(
    `INSERT INTO investment_assets (
       asset_id, unit_symbol, security_id, security_id_kind, price_provider,
       provider_symbol, manual_price_per_unit, manual_priced_at, benchmark_distributing
     ) VALUES (
       'fund', 'part.', 'IE00B4L5Y983', 'isin', 'finect',
       'IE00B4L5Y983-fondo', '118.75', '2026-03-01T09:00:00.000Z', 1
     )`,
  );
  return client;
}

async function investmentRow(client: Client) {
  const result = await client.execute(
    "SELECT * FROM investment_assets WHERE asset_id = 'fund'",
  );
  return result.rows[0];
}

async function storedVersion(client: Client): Promise<number> {
  return Number(
    (await client.execute("SELECT version FROM schema_meta")).rows[0]!.version,
  );
}

describe("schema migration v73 (hand-set price stamps cleared)", () => {
  test("clears the stamp a price carried, and leaves the price as it was", async () => {
    const client = await seedAt(71);

    await migrate(client);

    const row = await investmentRow(client);
    expect(row?.manual_priced_at).toBeNull();
    expect(row?.manual_price_per_unit).toBe("118.75");
    expect(await storedVersion(client)).toBe(SCHEMA_VERSION);
    expect(SCHEMA_VERSION).toBe(73);
  });

  test("runs on a database that already took #1812's v72", async () => {
    const client = await seedAt(72);

    await migrate(client);

    expect((await investmentRow(client))?.manual_priced_at).toBeNull();
    expect(await storedVersion(client)).toBe(73);
  });

  test("moves no other column of the row", async () => {
    const client = await seedAt(72);
    const before = await investmentRow(client);

    await migrate(client);

    const after = await investmentRow(client);
    const { manual_priced_at: _cleared, ...rest } = { ...after };
    const { manual_priced_at: _stamp, ...restBefore } = { ...before };
    expect(rest).toEqual(restBefore);
    expect(restBefore).toMatchObject({
      benchmark_distributing: 1,
      price_provider: "finect",
      provider_symbol: "IE00B4L5Y983-fondo",
      security_id: "IE00B4L5Y983",
      security_id_kind: "isin",
      unit_symbol: "part.",
    });
  });

  test("a second run leaves a stamp written after the rung alone", async () => {
    const client = await seedAt(72);
    await migrate(client);
    await client.execute(
      "UPDATE investment_assets SET manual_priced_at = '2026-10-12T10:00:00.000Z' WHERE asset_id = 'fund'",
    );

    await migrate(client);

    expect((await investmentRow(client))?.manual_priced_at).toBe(
      "2026-10-12T10:00:00.000Z",
    );
  });
});
