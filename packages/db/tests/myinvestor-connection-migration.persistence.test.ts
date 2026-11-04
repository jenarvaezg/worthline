/**
 * Schema migration v74 (#1879, ADR 0114/0115): the MyInvestor connection.
 *
 * - `connected_sources.asset_id` stops being required. A mirroring source (Numista,
 *   Binance) still materializes its rolled-up holding there; MyInvestor owns its
 *   holdings through operations (ADR 0115) and connects before it has any, so it has
 *   no mirror asset to point at.
 * - `connected_source_pending_logins` keeps the half-done login of the two-step SMS
 *   in the database, sealed and with an expiry (ADR 0114, decision 6), never in a
 *   cookie.
 *
 * The rebuild must carry every existing source, and the tables that reference it
 * (positions, sync runs) must keep resolving to it.
 */
import { openLibsqlClient } from "@db/index";
import { migrate, SCHEMA_VERSION } from "@db/migrate";
import { schemaSql } from "@db/schema-sql";
import type { Client } from "@libsql/client";
import { describe, expect, test } from "vitest";

/** The `connected_sources` DDL before v74: `asset_id` required. */
const V73_CONNECTED_SOURCES = `CREATE TABLE \`connected_sources\` (
	\`id\` text PRIMARY KEY NOT NULL,
	\`adapter\` text NOT NULL,
	\`label\` text NOT NULL,
	\`asset_id\` text NOT NULL,
	\`credentials_json\` text NOT NULL,
	\`token_json\` text,
	\`last_sync_at\` text,
	\`created_at\` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	\`updated_at\` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (\`asset_id\`) REFERENCES \`assets\`(\`id\`) ON UPDATE no action ON DELETE cascade
);`;

/** Today's schema rolled back to v73: the old source table, no pending logins. */
function schemaAtV73(): string {
  const statements = schemaSql.split("--> statement-breakpoint");
  return statements
    .filter(
      (statement) =>
        !statement.includes("connected_source_pending_logins") &&
        !statement.includes("connected_sources_myinvestor_unique"),
    )
    .map((statement) =>
      statement.includes("CREATE TABLE `connected_sources`")
        ? `\n${V73_CONNECTED_SOURCES}\n`
        : statement,
    )
    .join("--> statement-breakpoint");
}

/** A v73 database with a live Numista collection: its asset, a coin and a sync run. */
async function seedAtV73(): Promise<Client> {
  const client = openLibsqlClient(":memory:");
  await client.executeMultiple(schemaAtV73());
  await client.execute("CREATE TABLE schema_meta (version INTEGER NOT NULL)");
  await client.execute("INSERT INTO schema_meta (version) VALUES (73)");
  await client.execute(
    `INSERT INTO assets (id, name, type, currency, current_value_minor, liquidity_tier, instrument)
     VALUES ('coins', 'Colección Numista', 'manual', 'EUR', 1234, 'illiquid', 'coin_collection')`,
  );
  await client.execute(
    `INSERT INTO connected_sources (id, adapter, label, asset_id, credentials_json, last_sync_at)
     VALUES ('src', 'numista', 'Colección Numista', 'coins', 'sealed', '2026-10-01T08:00:00.000Z')`,
  );
  await client.execute(
    `INSERT INTO positions (id, source_id, name, liquidity_tier, currency)
     VALUES ('coin-1', 'src', 'Una moneda', 'illiquid', 'EUR')`,
  );
  await client.execute(
    `INSERT INTO sync_run (id, source_id, trigger, status)
     VALUES ('run-1', 'src', 'cron', 'ok')`,
  );
  return client;
}

async function storedVersion(client: Client): Promise<number> {
  return Number(
    (await client.execute("SELECT version FROM schema_meta")).rows[0]!.version,
  );
}

describe("schema migration v74 (the MyInvestor connection)", () => {
  test("keeps every existing source, and lets a new one have no mirror asset", async () => {
    const client = await seedAtV73();

    await migrate(client);

    const source = (await client.execute("SELECT * FROM connected_sources")).rows;
    expect(source).toHaveLength(1);
    expect(source[0]).toMatchObject({
      adapter: "numista",
      asset_id: "coins",
      credentials_json: "sealed",
      id: "src",
      last_sync_at: "2026-10-01T08:00:00.000Z",
    });

    await client.execute(
      `INSERT INTO connected_sources (id, adapter, label, asset_id, credentials_json)
       VALUES ('mi', 'myinvestor', 'MyInvestor', NULL, 'sealed')`,
    );
    expect(
      (await client.execute("SELECT asset_id FROM connected_sources WHERE id = 'mi'"))
        .rows[0]!.asset_id,
    ).toBeNull();
    expect(await storedVersion(client)).toBe(SCHEMA_VERSION);
    expect(SCHEMA_VERSION).toBe(78);
  });

  test("the tables that point at a source still resolve to it after the rebuild", async () => {
    const client = await seedAtV73();

    await migrate(client);

    // Deleting the mirror asset still cascades the source away, and with it its
    // positions and sync runs: the foreign keys survived the rebuild.
    await client.execute("DELETE FROM assets WHERE id = 'coins'");
    expect((await client.execute("SELECT * FROM connected_sources")).rows).toHaveLength(
      0,
    );
    expect((await client.execute("SELECT * FROM positions")).rows).toHaveLength(0);
    expect((await client.execute("SELECT * FROM sync_run")).rows).toHaveLength(0);
    const violations = await client.execute("PRAGMA foreign_key_check");
    expect(violations.rows).toHaveLength(0);
  });

  test("creates the pending-login table, one row per adapter", async () => {
    const client = await seedAtV73();

    await migrate(client);

    await client.execute(
      `INSERT INTO connected_source_pending_logins (id, adapter, payload_json, expires_at)
       VALUES ('p1', 'myinvestor', 'sealed', '2026-11-04T12:05:00.000Z')`,
    );
    await expect(
      client.execute(
        `INSERT INTO connected_source_pending_logins (id, adapter, payload_json, expires_at)
         VALUES ('p2', 'myinvestor', 'sealed', '2026-11-04T12:06:00.000Z')`,
      ),
    ).rejects.toThrow();
  });

  test("a workspace holds at most one MyInvestor connection; mirrors are unaffected", async () => {
    const client = await seedAtV73();

    await migrate(client);

    await client.execute(
      `INSERT INTO connected_sources (id, adapter, label, asset_id, credentials_json)
       VALUES ('mi', 'myinvestor', 'MyInvestor', NULL, 'sealed')`,
    );
    await expect(
      client.execute(
        `INSERT INTO connected_sources (id, adapter, label, asset_id, credentials_json)
         VALUES ('mi2', 'myinvestor', 'MyInvestor', NULL, 'sealed')`,
      ),
    ).rejects.toThrow();
  });

  test("a pending login starts with no code attempts", async () => {
    const client = await seedAtV73();

    await migrate(client);

    await client.execute(
      `INSERT INTO connected_source_pending_logins (id, adapter, payload_json, expires_at)
       VALUES ('p1', 'myinvestor', 'sealed', '2026-11-04T12:05:00.000Z')`,
    );
    const row = (
      await client.execute("SELECT attempts FROM connected_source_pending_logins")
    ).rows[0];
    expect(Number(row!.attempts)).toBe(0);
  });

  test("a fresh database is born at the same shape", async () => {
    const client = openLibsqlClient(":memory:");

    await migrate(client);

    await client.execute(
      `INSERT INTO connected_sources (id, adapter, label, asset_id, credentials_json)
       VALUES ('mi', 'myinvestor', 'MyInvestor', NULL, 'sealed')`,
    );
    await client.execute(
      `INSERT INTO connected_source_pending_logins (id, adapter, payload_json, expires_at)
       VALUES ('p1', 'myinvestor', 'sealed', '2026-11-04T12:05:00.000Z')`,
    );
    expect(await storedVersion(client)).toBe(SCHEMA_VERSION);
  });

  test("re-running the rung on a migrated database changes nothing", async () => {
    const client = await seedAtV73();
    await migrate(client);
    await client.execute("UPDATE schema_meta SET version = 73");

    await migrate(client);

    expect((await client.execute("SELECT * FROM connected_sources")).rows).toHaveLength(
      1,
    );
    expect((await client.execute("SELECT * FROM positions")).rows).toHaveLength(1);
    expect(await storedVersion(client)).toBe(SCHEMA_VERSION);
  });
});
