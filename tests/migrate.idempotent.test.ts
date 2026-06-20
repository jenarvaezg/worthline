import type { Client } from "@libsql/client";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { openLibsqlClient, SCHEMA_VERSION, withStore } from "@worthline/db";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

function tempDatabasePath(): string {
  const dataDir = mkdtempSync(join(tmpdir(), "worthline-migrate-"));
  tempDirs.push(dataDir);

  return join(dataDir, "worthline.sqlite");
}

async function tableNames(client: Client): Promise<string[]> {
  return (
    await client.execute(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
    )
  ).rows.map((row) => (row as unknown as { name: string }).name);
}

async function columnNames(client: Client, table: string): Promise<string[]> {
  return (await client.execute(`PRAGMA table_info(${table})`)).rows.map(
    (row) => (row as unknown as { name: string }).name,
  );
}

async function indexNames(client: Client, table: string): Promise<string[]> {
  return (
    await client.execute({
      sql: "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ?",
      args: [table],
    })
  ).rows.map((row) => (row as unknown as { name: string }).name);
}

/** The four hot-read indexes added in #201 (schema-version 23). */
const HOT_READ_INDEXES: ReadonlyArray<readonly [table: string, index: string]> = [
  ["asset_operations", "asset_operations_asset_executed_idx"],
  ["audit_log", "audit_log_entity_created_idx"],
  ["assets", "assets_deleted_at_idx"],
  ["liabilities", "liabilities_deleted_at_idx"],
];

async function userVersion(client: Client): Promise<number> {
  return Number((await client.execute("PRAGMA user_version")).rows[0]!.user_version);
}

describe("migrate idempotency", () => {
  test("opening an already-migrated database twice does not throw", async () => {
    const databasePath = tempDatabasePath();

    await withStore(
      async (store) => {
        await store.workspace.initializeWorkspace({
          members: [{ id: "member_jose", name: "Jose" }],
          mode: "individual",
        });
      },
      { databasePath },
    );

    await expect(
      withStore(async (store) => (await store.workspace.readWorkspace())?.mode, {
        databasePath,
      }),
    ).resolves.not.toThrow();
  });

  test("migrates a legacy database that has tables but no user_version", async () => {
    const databasePath = tempDatabasePath();

    const legacy = openLibsqlClient(databasePath);
    await legacy.executeMultiple(
      "CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)",
    );
    legacy.close();

    await expect(
      withStore(async (store) => await store.workspace.readWorkspace(), { databasePath }),
    ).resolves.not.toThrow();
  });
});

describe("fresh database", () => {
  test("creates all tables with correct columns", async () => {
    const databasePath = tempDatabasePath();

    await withStore(
      async (store) => {
        await store.workspace.initializeWorkspace({
          members: [{ id: "member_jose", name: "Jose" }],
          mode: "individual",
        });
      },
      { databasePath },
    );

    const client = openLibsqlClient(databasePath);
    try {
      expect(await userVersion(client)).toBe(SCHEMA_VERSION);
      expect(await tableNames(client)).toContain("warning_overrides");

      const tables = await tableNames(client);
      for (const expected of [
        "app_settings",
        "workspace",
        "members",
        "member_groups",
        "member_group_members",
        "assets",
        "asset_ownerships",
        "investment_assets",
        "asset_operations",
        "liabilities",
        "liability_ownerships",
        "asset_price_cache",
        "audit_log",
        "snapshots",
        "snapshot_holdings",
        "asset_valuations",
        "amortization_plans",
        "interest_rate_revisions",
        "liability_balance_anchors",
        "early_repayments",
      ]) {
        expect(tables).toContain(expected);
      }

      const assetColumns = await columnNames(client, "assets");
      expect(assetColumns).toContain("deleted_at");
      expect(assetColumns).toContain("annual_appreciation_rate");

      const liabilityColumns = await columnNames(client, "liabilities");
      expect(liabilityColumns).toContain("deleted_at");
      expect(liabilityColumns).toContain("debt_model");

      const investmentColumns = await columnNames(client, "investment_assets");
      expect(investmentColumns).toContain("price_provider");

      // #201: the hot-read indexes are present on a fresh database (created from
      // schema-sql at v<2), so the runtime SQL and the migration ladder agree.
      for (const [table, indexName] of HOT_READ_INDEXES) {
        expect(await indexNames(client, table)).toContain(indexName);
      }
    } finally {
      client.close();
    }
  });
});

describe("forward migration from v2", () => {
  test("a v2 database gets asset_price_cache, audit_log, and deleted_at columns", async () => {
    const databasePath = tempDatabasePath();

    const v2 = openLibsqlClient(databasePath);
    await v2.executeMultiple(
      `CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
       CREATE TABLE workspace (id TEXT PRIMARY KEY, mode TEXT NOT NULL, base_currency TEXT NOT NULL, created_at TEXT, updated_at TEXT);
       CREATE TABLE members (id TEXT PRIMARY KEY, name TEXT NOT NULL, disabled_at TEXT, created_at TEXT, updated_at TEXT);
       CREATE TABLE member_groups (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT, updated_at TEXT);
       CREATE TABLE member_group_members (group_id TEXT NOT NULL, member_id TEXT NOT NULL, sort_order INTEGER NOT NULL, PRIMARY KEY(group_id, member_id));
       CREATE TABLE assets (id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL, currency TEXT NOT NULL, current_value_minor INTEGER NOT NULL, liquidity_tier TEXT NOT NULL, is_primary_residence INTEGER DEFAULT 0 NOT NULL, created_at TEXT, updated_at TEXT);
       CREATE TABLE asset_ownerships (asset_id TEXT NOT NULL, member_id TEXT NOT NULL, share_bps INTEGER NOT NULL, PRIMARY KEY(asset_id, member_id));
       CREATE TABLE liabilities (id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL, currency TEXT NOT NULL, current_balance_minor INTEGER NOT NULL, associated_asset_id TEXT, created_at TEXT, updated_at TEXT);
       CREATE TABLE liability_ownerships (liability_id TEXT NOT NULL, member_id TEXT NOT NULL, share_bps INTEGER NOT NULL, PRIMARY KEY(liability_id, member_id));
       CREATE TABLE snapshots (id TEXT PRIMARY KEY, scope_id TEXT NOT NULL, scope_label TEXT NOT NULL, captured_at TEXT NOT NULL, date_key TEXT NOT NULL, month_key TEXT NOT NULL, is_monthly_close INTEGER DEFAULT 0 NOT NULL, currency TEXT NOT NULL, total_net_worth_minor INTEGER NOT NULL, liquid_net_worth_minor INTEGER NOT NULL, housing_equity_minor INTEGER NOT NULL, gross_assets_minor INTEGER NOT NULL, debts_minor INTEGER NOT NULL, warnings_json TEXT DEFAULT '[]' NOT NULL, created_at TEXT);
       CREATE UNIQUE INDEX snapshots_scope_date_unique ON snapshots (scope_id, date_key);
       CREATE TABLE asset_operations (id TEXT PRIMARY KEY, asset_id TEXT NOT NULL, kind TEXT NOT NULL, executed_at TEXT NOT NULL, units TEXT NOT NULL, price_per_unit TEXT NOT NULL, currency TEXT NOT NULL, fees_minor INTEGER DEFAULT 0 NOT NULL, created_at TEXT);
       CREATE TABLE investment_assets (asset_id TEXT PRIMARY KEY, unit_symbol TEXT, isin TEXT, provider_symbol TEXT, manual_price_per_unit TEXT, manual_priced_at TEXT);`,
    );
    await v2.execute("PRAGMA user_version = 2");
    v2.close();

    await withStore(
      async (store) => {
        expect(await store.workspace.readWorkspace()).toBeNull();
      },
      { databasePath },
    );

    const client = openLibsqlClient(databasePath);
    try {
      expect(await userVersion(client)).toBe(SCHEMA_VERSION);
      expect(await tableNames(client)).toContain("warning_overrides");
      expect(await tableNames(client)).toContain("asset_price_cache");
      expect(await tableNames(client)).toContain("audit_log");
      expect(await tableNames(client)).toContain("snapshot_holdings");
      expect(await tableNames(client)).toContain("asset_valuations");
      expect(await tableNames(client)).toContain("amortization_plans");
      expect(await tableNames(client)).toContain("interest_rate_revisions");
      expect(await tableNames(client)).toContain("liability_balance_anchors");
      expect(await tableNames(client)).toContain("early_repayments");
      expect(await columnNames(client, "assets")).toContain("deleted_at");
      expect(await columnNames(client, "assets")).toContain("annual_appreciation_rate");
      expect(await columnNames(client, "liabilities")).toContain("deleted_at");
      expect(await columnNames(client, "liabilities")).toContain("debt_model");
      expect(await columnNames(client, "investment_assets")).toContain("price_provider");

      // #201: a legacy v2 database gains the hot-read indexes through the v23
      // migration block (asset_operations/audit_log/assets/liabilities did not yet
      // carry them), proving the ladder backfills them — not just a fresh schema-sql.
      for (const [table, indexName] of HOT_READ_INDEXES) {
        expect(await indexNames(client, table)).toContain(indexName);
      }
    } finally {
      client.close();
    }
  });
});

describe("forward migration from v3", () => {
  test("a v3 database gets audit_log and deleted_at columns", async () => {
    const databasePath = tempDatabasePath();

    const v3 = openLibsqlClient(databasePath);
    await v3.executeMultiple(
      `CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
       CREATE TABLE workspace (id TEXT PRIMARY KEY, mode TEXT NOT NULL, base_currency TEXT NOT NULL, created_at TEXT, updated_at TEXT);
       CREATE TABLE members (id TEXT PRIMARY KEY, name TEXT NOT NULL, disabled_at TEXT, created_at TEXT, updated_at TEXT);
       CREATE TABLE member_groups (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT, updated_at TEXT);
       CREATE TABLE member_group_members (group_id TEXT NOT NULL, member_id TEXT NOT NULL, sort_order INTEGER NOT NULL, PRIMARY KEY(group_id, member_id));
       CREATE TABLE assets (id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL, currency TEXT NOT NULL, current_value_minor INTEGER NOT NULL, liquidity_tier TEXT NOT NULL, is_primary_residence INTEGER DEFAULT 0 NOT NULL, created_at TEXT, updated_at TEXT);
       CREATE TABLE asset_ownerships (asset_id TEXT NOT NULL, member_id TEXT NOT NULL, share_bps INTEGER NOT NULL, PRIMARY KEY(asset_id, member_id));
       CREATE TABLE liabilities (id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL, currency TEXT NOT NULL, current_balance_minor INTEGER NOT NULL, associated_asset_id TEXT, created_at TEXT, updated_at TEXT);
       CREATE TABLE liability_ownerships (liability_id TEXT NOT NULL, member_id TEXT NOT NULL, share_bps INTEGER NOT NULL, PRIMARY KEY(liability_id, member_id));
       CREATE TABLE snapshots (id TEXT PRIMARY KEY, scope_id TEXT NOT NULL, scope_label TEXT NOT NULL, captured_at TEXT NOT NULL, date_key TEXT NOT NULL, month_key TEXT NOT NULL, is_monthly_close INTEGER DEFAULT 0 NOT NULL, currency TEXT NOT NULL, total_net_worth_minor INTEGER NOT NULL, liquid_net_worth_minor INTEGER NOT NULL, housing_equity_minor INTEGER NOT NULL, gross_assets_minor INTEGER NOT NULL, debts_minor INTEGER NOT NULL, warnings_json TEXT DEFAULT '[]' NOT NULL, created_at TEXT);
       CREATE UNIQUE INDEX snapshots_scope_date_unique ON snapshots (scope_id, date_key);
       CREATE TABLE asset_operations (id TEXT PRIMARY KEY, asset_id TEXT NOT NULL, kind TEXT NOT NULL, executed_at TEXT NOT NULL, units TEXT NOT NULL, price_per_unit TEXT NOT NULL, currency TEXT NOT NULL, fees_minor INTEGER DEFAULT 0 NOT NULL, created_at TEXT);
       CREATE TABLE investment_assets (asset_id TEXT PRIMARY KEY, unit_symbol TEXT, isin TEXT, provider_symbol TEXT, manual_price_per_unit TEXT, manual_priced_at TEXT);
       CREATE TABLE asset_price_cache (asset_id TEXT PRIMARY KEY, currency TEXT NOT NULL, price TEXT NOT NULL, source TEXT DEFAULT 'manual' NOT NULL, price_date TEXT, fetched_at TEXT NOT NULL, freshness_state TEXT DEFAULT 'manual' NOT NULL, stale_reason TEXT, created_at TEXT, updated_at TEXT);`,
    );
    await v3.execute("PRAGMA user_version = 3");
    v3.close();

    await withStore(
      async (store) => {
        expect(await store.workspace.readWorkspace()).toBeNull();
      },
      { databasePath },
    );

    const client = openLibsqlClient(databasePath);
    try {
      expect(await userVersion(client)).toBe(SCHEMA_VERSION);
      expect(await tableNames(client)).toContain("warning_overrides");
      expect(await tableNames(client)).toContain("audit_log");
      expect(await tableNames(client)).toContain("snapshot_holdings");
      expect(await tableNames(client)).toContain("asset_valuations");
      expect(await tableNames(client)).toContain("amortization_plans");
      expect(await tableNames(client)).toContain("interest_rate_revisions");
      expect(await tableNames(client)).toContain("liability_balance_anchors");
      expect(await tableNames(client)).toContain("early_repayments");
      expect(await columnNames(client, "assets")).toContain("deleted_at");
      expect(await columnNames(client, "assets")).toContain("annual_appreciation_rate");
      expect(await columnNames(client, "liabilities")).toContain("deleted_at");
      expect(await columnNames(client, "liabilities")).toContain("debt_model");
      expect(await columnNames(client, "investment_assets")).toContain("price_provider");
    } finally {
      client.close();
    }
  });
});
