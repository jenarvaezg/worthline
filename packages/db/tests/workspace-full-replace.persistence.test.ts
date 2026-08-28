/**
 * The two full-replace paths (#1603): `resetWorkspace` and `importWorkspace` wipe
 * through the one shared `wipeWorkspaceTables`, so this pins what that wipe must
 * mean — every table in the schema, not a hand-kept list that can fall behind it.
 *
 * The survivors are read from `sqlite_master`, never from `WORKSPACE_TABLES`, so
 * a table added to the schema and forgotten in the wipe list fails here instead
 * of quietly outliving a reset (ADR 0010).
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openLibsqlClient } from "@db/index";
import { createWorthlineStoreUnsafe } from "@db/unsafe-store";
import type { Client } from "@libsql/client";
import { describe, expect, test } from "vitest";

type Store = Awaited<ReturnType<typeof createWorthlineStoreUnsafe>>;

/** `schema_meta` records the migration version, not workspace data — a wipe must keep it. */
const NOT_WORKSPACE_DATA = new Set(["schema_meta", "sqlite_sequence"]);

function freshPath(): string {
  return join(mkdtempSync(join(tmpdir(), "wl-replace-")), "w.sqlite");
}

/** A workspace with something in as many tables as the public API reaches. */
async function seed(store: Store, suffix: string): Promise<void> {
  await store.workspace.initializeWorkspace({
    members: [{ id: `m-${suffix}`, name: `Miembro ${suffix}` }],
    mode: "individual",
  });
  await store.assets.createManualAsset({
    currency: "EUR",
    currentValueMinor: 100000,
    id: `a-${suffix}`,
    liquidityTier: "cash",
    name: `Cuenta ${suffix}`,
    ownership: [{ memberId: `m-${suffix}`, shareBps: 10000 }],
    type: "cash",
  });
  await store.liabilities.createLiability({
    balanceMinor: 30000,
    currency: "EUR",
    id: `l-${suffix}`,
    name: `Deuda ${suffix}`,
    ownership: [{ memberId: `m-${suffix}`, shareBps: 10000 }],
    type: "debt",
  });
  await store.acknowledgeWarning("zero_value_asset", `a-${suffix}`);
}

/** Row counts of every table in the database, keyed by table name. */
async function rowCounts(databasePath: string): Promise<Map<string, number>> {
  const client: Client = openLibsqlClient(`file:${databasePath}`);
  const tables = (
    await client.execute(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
    )
  ).rows.map((row) => String(row.name));

  const counts = new Map<string, number>();
  for (const table of tables) {
    if (NOT_WORKSPACE_DATA.has(table)) continue;
    const result = await client.execute(`SELECT COUNT(*) AS n FROM ${table}`);
    counts.set(table, Number(result.rows[0]?.n ?? 0));
  }
  client.close();
  return counts;
}

function populated(counts: Map<string, number>): string[] {
  return [...counts]
    .filter(([, n]) => n > 0)
    .map(([table]) => table)
    .sort();
}

describe("the two full-replace paths share one wipe (#1603)", () => {
  test("resetWorkspace leaves no row in any table of the schema", async () => {
    const databasePath = freshPath();
    const store = await createWorthlineStoreUnsafe({ databasePath });
    await seed(store, "A");
    expect(populated(await rowCounts(databasePath)).length).toBeGreaterThan(0);

    await store.workspace.resetWorkspace();
    store.close();

    expect(populated(await rowCounts(databasePath))).toEqual([]);
  });

  test("importWorkspace wipes the same tables: only the document's own rows remain", async () => {
    // The document of a workspace that holds nothing but its member — so every
    // table it does NOT refill must come out of the import empty.
    const sourcePath = freshPath();
    const source = await createWorthlineStoreUnsafe({ databasePath: sourcePath });
    await source.workspace.initializeWorkspace({
      members: [{ id: "m-B", name: "Miembro B" }],
      mode: "individual",
    });
    const document = await source.workspace.exportWorkspace();
    source.close();

    const targetPath = freshPath();
    const target = await createWorthlineStoreUnsafe({ databasePath: targetPath });
    await seed(target, "A");
    await target.workspace.importWorkspace(document);
    target.close();

    // Exactly the tables the bare document refills — an asset, an ownership or a
    // warning override surviving here would be a table the wipe failed to reach.
    expect(populated(await rowCounts(targetPath))).toEqual([
      "agent_view_public_ids",
      "audit_log",
      "members",
      "workspace",
    ]);
  });
});
