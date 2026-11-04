/**
 * Schema migration v75 (#1880, ADR 0066/0115): the first start of MyInvestor.
 *
 * - `connected_sources.ingest_cursor`: where the ingestion port resumes.
 * - `connected_source_discoveries`: what the last read of a source found.
 * - `connected_source_links`: which product each linked holding is.
 * - `connector_applied_facts`: the port's dedup ledger.
 *
 * Additive: every existing source keeps its row, and a re-run changes nothing.
 */
import { openLibsqlClient } from "@db/index";
import { migrate, SCHEMA_VERSION } from "@db/migrate";
import { schemaSql } from "@db/schema-sql";
import type { Client } from "@libsql/client";
import { describe, expect, test } from "vitest";

const V75_TABLES = [
  "connected_source_discoveries",
  "connected_source_links",
  "connector_applied_facts",
];

/** Today's schema rolled back to v74: no cursor column, none of the three tables. */
function schemaAtV74(): string {
  return schemaSql
    .split("--> statement-breakpoint")
    .filter((statement) => !V75_TABLES.some((table) => statement.includes(table)))
    .map((statement) => statement.replace("\t`ingest_cursor` text,\n", ""))
    .join("--> statement-breakpoint");
}

async function seedAtV74(): Promise<Client> {
  const client = openLibsqlClient(":memory:");
  await client.executeMultiple(schemaAtV74());
  await client.execute("CREATE TABLE schema_meta (version INTEGER NOT NULL)");
  await client.execute("INSERT INTO schema_meta (version) VALUES (74)");
  await client.execute(
    `INSERT INTO connected_sources (id, adapter, label, asset_id, credentials_json)
     VALUES ('mi', 'myinvestor', 'MyInvestor', NULL, 'sealed')`,
  );
  return client;
}

async function columns(client: Client): Promise<string[]> {
  return (await client.execute("PRAGMA table_info(connected_sources)")).rows.map((row) =>
    String(row.name),
  );
}

async function tables(client: Client): Promise<string[]> {
  return (
    await client.execute("SELECT name FROM sqlite_master WHERE type = 'table'")
  ).rows.map((row) => String(row.name));
}

describe("schema migration v75 (the first start of MyInvestor)", () => {
  test("adds the cursor and the three tables, keeping the connection", async () => {
    const client = await seedAtV74();
    expect(await columns(client)).not.toContain("ingest_cursor");

    await migrate(client);

    expect(SCHEMA_VERSION).toBe(77);
    expect(await columns(client)).toContain("ingest_cursor");
    expect(await tables(client)).toEqual(expect.arrayContaining(V75_TABLES));
    const source = (
      await client.execute("SELECT id, ingest_cursor FROM connected_sources")
    ).rows;
    expect(source).toEqual([{ id: "mi", ingest_cursor: null }]);

    await client.execute(
      `INSERT INTO connected_source_discoveries (source_id, read_on, payload_json)
       VALUES ('mi', '2026-11-04', '{}')`,
    );
    await client.execute(
      `INSERT INTO connector_applied_facts (source_id, fact_key, batch_id)
       VALUES ('mi', 'ref-1', 'batch-1')`,
    );
    await expect(
      client.execute(
        `INSERT INTO connector_applied_facts (source_id, fact_key, batch_id)
         VALUES ('mi', 'ref-1', 'batch-2')`,
      ),
    ).rejects.toThrow();
  });

  test("re-running the rung on a migrated database changes nothing", async () => {
    const client = await seedAtV74();
    await migrate(client);
    await client.execute("UPDATE schema_meta SET version = 74");

    await migrate(client);

    expect(
      (await columns(client)).filter((name) => name === "ingest_cursor"),
    ).toHaveLength(1);
    expect((await client.execute("SELECT * FROM connected_sources")).rows).toHaveLength(
      1,
    );
  });
});
