import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { withStore } from "@worthline/db";

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

function tableNames(sqlite: Database): string[] {
  return sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all()
    .map((row) => (row as { name: string }).name);
}

function columnNames(sqlite: Database, table: string): string[] {
  return sqlite
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .map((row) => (row as { name: string }).name);
}

function userVersion(sqlite: Database): number {
  return sqlite.pragma("user_version", { simple: true }) as number;
}

describe("migrate idempotency", () => {
  test("opening an already-migrated database twice does not throw", () => {
    const databasePath = tempDatabasePath();

    withStore(
      (store) => {
        store.initializeWorkspace({
          members: [{ id: "member_jose", name: "Jose" }],
          mode: "individual",
        });
      },
      { databasePath },
    );

    expect(() =>
      withStore((store) => store.readWorkspace()?.mode, { databasePath }),
    ).not.toThrow();
  });

  test("migrates a legacy database that has tables but no user_version", () => {
    const databasePath = tempDatabasePath();

    const legacy = new Database(databasePath);
    legacy.exec(
      "CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)",
    );
    legacy.close();

    expect(() =>
      withStore((store) => store.readWorkspace(), { databasePath }),
    ).not.toThrow();
  });
});

describe("fresh database", () => {
  test("creates all tables with correct columns", () => {
    const databasePath = tempDatabasePath();

    withStore(
      (store) => {
        store.initializeWorkspace({
          members: [{ id: "member_jose", name: "Jose" }],
          mode: "individual",
        });
      },
      { databasePath },
    );

    const sqlite = new Database(databasePath);
    try {
      expect(userVersion(sqlite)).toBe(8);
      expect(tableNames(sqlite)).toContain("warning_overrides");

      const tables = tableNames(sqlite);
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
      ]) {
        expect(tables).toContain(expected);
      }

      const assetColumns = columnNames(sqlite, "assets");
      expect(assetColumns).toContain("deleted_at");

      const liabilityColumns = columnNames(sqlite, "liabilities");
      expect(liabilityColumns).toContain("deleted_at");

      const investmentColumns = columnNames(sqlite, "investment_assets");
      expect(investmentColumns).toContain("price_provider");
    } finally {
      sqlite.close();
    }
  });
});

describe("forward migration from v2", () => {
  test("a v2 database gets asset_price_cache, audit_log, and deleted_at columns", () => {
    const databasePath = tempDatabasePath();

    const v2 = new Database(databasePath);
    v2.exec(
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
    v2.pragma("user_version = 2");
    v2.close();

    withStore(
      (store) => {
        expect(store.readWorkspace()).toBeNull();
      },
      { databasePath },
    );

    const sqlite = new Database(databasePath);
    try {
      expect(userVersion(sqlite)).toBe(8);
      expect(tableNames(sqlite)).toContain("warning_overrides");
      expect(tableNames(sqlite)).toContain("asset_price_cache");
      expect(tableNames(sqlite)).toContain("audit_log");
      expect(tableNames(sqlite)).toContain("snapshot_holdings");
      expect(columnNames(sqlite, "assets")).toContain("deleted_at");
      expect(columnNames(sqlite, "liabilities")).toContain("deleted_at");
      expect(columnNames(sqlite, "investment_assets")).toContain("price_provider");
    } finally {
      sqlite.close();
    }
  });
});

describe("forward migration from v3", () => {
  test("a v3 database gets audit_log and deleted_at columns", () => {
    const databasePath = tempDatabasePath();

    const v3 = new Database(databasePath);
    v3.exec(
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
    v3.pragma("user_version = 3");
    v3.close();

    withStore(
      (store) => {
        expect(store.readWorkspace()).toBeNull();
      },
      { databasePath },
    );

    const sqlite = new Database(databasePath);
    try {
      expect(userVersion(sqlite)).toBe(8);
      expect(tableNames(sqlite)).toContain("warning_overrides");
      expect(tableNames(sqlite)).toContain("audit_log");
      expect(tableNames(sqlite)).toContain("snapshot_holdings");
      expect(columnNames(sqlite, "assets")).toContain("deleted_at");
      expect(columnNames(sqlite, "liabilities")).toContain("deleted_at");
      expect(columnNames(sqlite, "investment_assets")).toContain("price_provider");
    } finally {
      sqlite.close();
    }
  });
});
