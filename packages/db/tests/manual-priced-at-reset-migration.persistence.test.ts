/**
 * Schema migration v72 (#1731 review): every hand-set price stamp from before it is
 * cleared.
 *
 * Until #1828 `manual_priced_at` was written once, at the alta, and never again — so
 * a stamp already in a database may be the day the holding was created rather than
 * the day its price was typed, and the ficha would print «precio a mano · <alta>»
 * beside a price set months later. Which stamps are honest cannot be told apart, so
 * the rung clears them all: the header then says «precio a mano» with no day until
 * the next price change stamps one. The price itself is untouched.
 */
import { openLibsqlClient } from "@db/index";
import { migrate, SCHEMA_VERSION } from "@db/migrate";
import { schemaSql } from "@db/schema-sql";
import type { Client } from "@libsql/client";
import { describe, expect, test } from "vitest";

/** A v71 database holding one fund priced by hand, stamped by its alta. */
async function seedV71(): Promise<Client> {
  const client = openLibsqlClient(":memory:");
  await client.executeMultiple(schemaSql);
  await client.execute("CREATE TABLE schema_meta (version INTEGER NOT NULL)");
  await client.execute("INSERT INTO schema_meta (version) VALUES (71)");
  await client.execute(
    `INSERT INTO assets (id, name, type, currency, current_value_minor, liquidity_tier)
     VALUES ('fund', 'Fondo', 'investment', 'EUR', 0, 'market')`,
  );
  await client.execute(
    `INSERT INTO investment_assets (asset_id, manual_price_per_unit, manual_priced_at)
     VALUES ('fund', '118.75', '2026-03-01T09:00:00.000Z')`,
  );
  return client;
}

async function investmentRow(client: Client) {
  const result = await client.execute(
    "SELECT manual_price_per_unit, manual_priced_at FROM investment_assets WHERE asset_id = 'fund'",
  );
  return result.rows[0];
}

describe("schema migration v72 (hand-set price stamps cleared)", () => {
  test("clears the stamp a price carried, and leaves the price as it was", async () => {
    const client = await seedV71();

    await migrate(client);

    const row = await investmentRow(client);
    expect(row?.manual_priced_at).toBeNull();
    expect(row?.manual_price_per_unit).toBe("118.75");
    expect(
      Number((await client.execute("SELECT version FROM schema_meta")).rows[0]!.version),
    ).toBe(SCHEMA_VERSION);
    expect(SCHEMA_VERSION).toBe(72);
  });

  test("a second run leaves a stamp written after the rung alone", async () => {
    const client = await seedV71();
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
