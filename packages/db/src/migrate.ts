import type { Database as DatabaseConnection } from "better-sqlite3";

import { schemaSql } from "./schema-sql";

export const SCHEMA_VERSION = 9;

export function migrate(sqlite: DatabaseConnection): void {
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");

  const version = sqlite.pragma("user_version", { simple: true }) as number;
  if (version >= SCHEMA_VERSION) return;

  if (version < 2) {
    const safeSql = schemaSql
      .replaceAll("CREATE TABLE ", "CREATE TABLE IF NOT EXISTS ")
      .replaceAll("CREATE UNIQUE INDEX ", "CREATE UNIQUE INDEX IF NOT EXISTS ");
    sqlite.exec(safeSql);
    sqlite.pragma("user_version = 2");
  }

  if (version < 3) {
    sqlite.exec(`CREATE TABLE IF NOT EXISTS asset_price_cache (
      asset_id TEXT PRIMARY KEY NOT NULL, currency TEXT NOT NULL, price TEXT NOT NULL,
      source TEXT DEFAULT 'manual' NOT NULL, price_date TEXT, fetched_at TEXT NOT NULL,
      freshness_state TEXT DEFAULT 'manual' NOT NULL, stale_reason TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL,
      FOREIGN KEY (asset_id) REFERENCES assets(id) ON UPDATE no action ON DELETE cascade
    );`);
    sqlite.pragma("user_version = 3");
  }

  if (version < 4) {
    sqlite.exec(`CREATE TABLE IF NOT EXISTS audit_log (
      id TEXT PRIMARY KEY NOT NULL, action TEXT NOT NULL,
      entity_type TEXT NOT NULL, entity_id TEXT NOT NULL,
      details_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL
    );`);
    try {
      sqlite.exec("ALTER TABLE assets ADD COLUMN deleted_at TEXT");
    } catch {}
    try {
      sqlite.exec("ALTER TABLE liabilities ADD COLUMN deleted_at TEXT");
    } catch {}
    sqlite.pragma("user_version = 4");
  }

  if (version < 5) {
    sqlite.exec(`CREATE TABLE IF NOT EXISTS warning_overrides (
      code TEXT NOT NULL, entity_id TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL,
      PRIMARY KEY (code, entity_id)
    );`);
    sqlite.pragma("user_version = 5");
  }

  if (version < 6) {
    // ADR 0005: monthly closes are now derived (last snapshot of each calendar
    // month), not declared via the is_monthly_close flag. The column is kept for
    // backward compatibility but derivation wins over any persisted flag.
    // No structural change needed — bump version to mark the semantic transition.
    sqlite.pragma("user_version = 6");
  }

  if (version < 7) {
    // ADR 0008: snapshots capture the valued portfolio holding by holding.
    // Label and tier are denormalized on purpose (frozen history) — the only
    // foreign key points at the owning snapshot row, never into holdings.
    sqlite.exec(`CREATE TABLE IF NOT EXISTS snapshot_holdings (
      id TEXT PRIMARY KEY NOT NULL,
      snapshot_id TEXT NOT NULL,
      holding_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      label TEXT NOT NULL,
      liquidity_tier TEXT,
      value_minor INTEGER NOT NULL,
      units TEXT,
      unit_price TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL,
      FOREIGN KEY (snapshot_id) REFERENCES snapshots(id) ON UPDATE no action ON DELETE cascade
    );`);
    sqlite.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS snapshot_holdings_snapshot_kind_holding_unique
       ON snapshot_holdings (snapshot_id, kind, holding_id);`,
    );
    sqlite.pragma("user_version = 7");
  }

  if (version < 8) {
    try {
      sqlite.exec("ALTER TABLE investment_assets ADD COLUMN price_provider TEXT");
    } catch {}
    sqlite.pragma("user_version = 8");
  }

  if (version < 9) {
    // PRD #108 slice 4: housing valuation anchors + an appreciation rate on the
    // owning asset. The anchor→real_estate invariant is a domain/caller guard,
    // not a SQL constraint (R9).
    try {
      sqlite.exec("ALTER TABLE assets ADD COLUMN annual_appreciation_rate TEXT");
    } catch {}
    sqlite.exec(`CREATE TABLE IF NOT EXISTS asset_valuations (
      id TEXT PRIMARY KEY NOT NULL,
      asset_id TEXT NOT NULL,
      value_minor INTEGER NOT NULL,
      valuation_date TEXT NOT NULL,
      adjusts_prior_curve INTEGER NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL,
      FOREIGN KEY (asset_id) REFERENCES assets(id) ON UPDATE no action ON DELETE cascade
    );`);
    sqlite.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS asset_valuations_asset_date_unique
       ON asset_valuations (asset_id, valuation_date);`,
    );
    sqlite.pragma("user_version = 9");
  }
}
