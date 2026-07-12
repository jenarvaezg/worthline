import { openLibsqlClient } from "@db/libsql-client";
import { migrate, readSchemaVersion, writeSchemaVersion } from "@db/migrate";
import type { Client } from "@libsql/client";
import { afterEach, describe, expect, it } from "vitest";

const clients: Client[] = [];

afterEach(() => {
  for (const client of clients.splice(0)) client.close();
});

describe("assistant proposals migration", () => {
  it("upgrades a v46 database with proposal, document-reference, and fact tables", async () => {
    const client = openLibsqlClient(":memory:");
    clients.push(client);
    await writeSchemaVersion(client, 46);

    await migrate(client);

    const tables = await client.execute(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'assistant_proposal%' ORDER BY name",
    );
    expect(tables.rows.map((row) => row.name)).toEqual([
      "assistant_proposal_documents",
      "assistant_proposal_facts",
      "assistant_proposals",
    ]);
    const documentColumns = await client.execute(
      "PRAGMA table_info(assistant_proposal_documents)",
    );
    expect(documentColumns.rows.map((row) => row.name)).toEqual([
      "id",
      "proposal_id",
      "sequence",
      "name",
      "sha256",
      "provenance",
      "created_at",
    ]);
    expect(await readSchemaVersion(client)).toBe(48);
  });
});
