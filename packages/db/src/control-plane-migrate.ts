import type { Client } from "@libsql/client";

export const CP_SCHEMA_VERSION = 3;

const SCHEMA_META_TABLE =
  "CREATE TABLE IF NOT EXISTS cp_schema_meta (version INTEGER NOT NULL)";

function isTursoRejectedStatement(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /SQL_PARSE_ERROR|not allowed statement/i.test(message);
}

export async function readControlPlaneSchemaVersion(client: Client): Promise<number> {
  try {
    const result = await client.execute("SELECT version FROM cp_schema_meta LIMIT 1");
    if (result.rows.length > 0) {
      return Number(result.rows[0]!.version);
    }
  } catch (err) {
    if (!/no such table/i.test(err instanceof Error ? err.message : String(err))) {
      throw err;
    }
  }
  return Number((await client.execute("PRAGMA user_version")).rows[0]!.user_version);
}

export async function writeControlPlaneSchemaVersion(
  client: Client,
  version: number,
): Promise<void> {
  await client.execute(SCHEMA_META_TABLE);
  await client.execute("DELETE FROM cp_schema_meta");
  await client.execute({
    sql: "INSERT INTO cp_schema_meta (version) VALUES (?)",
    args: [version],
  });
  try {
    await client.execute(`PRAGMA user_version = ${version}`);
  } catch (err) {
    if (!isTursoRejectedStatement(err)) {
      throw err;
    }
  }
}

export async function migrateControlPlane(client: Client): Promise<void> {
  const version = await readControlPlaneSchemaVersion(client);
  if (version >= CP_SCHEMA_VERSION) {
    return;
  }

  if (version < 1) {
    await client.executeMultiple(`CREATE TABLE IF NOT EXISTS global_exposure_profiles (
      identity_key TEXT PRIMARY KEY NOT NULL,
      identity_kind TEXT NOT NULL,
      isin TEXT,
      price_provider TEXT,
      provider_symbol TEXT,
      display_name TEXT,
      breakdowns_json TEXT NOT NULL DEFAULT '{}',
      ter TEXT,
      tracked_index TEXT,
      hedged_to_currency TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE UNIQUE INDEX IF NOT EXISTS global_exposure_profiles_isin
      ON global_exposure_profiles(isin) WHERE isin IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS global_exposure_profiles_provider
      ON global_exposure_profiles(price_provider, provider_symbol)
      WHERE price_provider IS NOT NULL AND provider_symbol IS NOT NULL;`);
    await writeControlPlaneSchemaVersion(client, 1);
  }

  if (version < 2) {
    // Maintainer alerts (#1050, ADR 0064): control-plane-only, so no workspace
    // export can drag maintainer material out.
    await client.executeMultiple(`CREATE TABLE IF NOT EXISTS maintainer_alerts (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      holding_id TEXT NOT NULL,
      category TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      occurrence_count INTEGER NOT NULL DEFAULT 0,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      resolution_note TEXT,
      resolution_link TEXT,
      resolved_at TEXT,
      supersedes_alert_id TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE UNIQUE INDEX IF NOT EXISTS maintainer_alerts_one_open_per_key
      ON maintainer_alerts(workspace_id, holding_id, category) WHERE status = 'open';
    CREATE INDEX IF NOT EXISTS maintainer_alerts_recency
      ON maintainer_alerts(last_seen_at);
    CREATE TABLE IF NOT EXISTS maintainer_alert_occurrences (
      id TEXT PRIMARY KEY,
      alert_id TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (alert_id) REFERENCES maintainer_alerts(id)
    );
    CREATE INDEX IF NOT EXISTS maintainer_alert_occurrences_alert
      ON maintainer_alert_occurrences(alert_id);`);
    await writeControlPlaneSchemaVersion(client, 2);
  }

  if (version < 3) {
    // Durable job queue (#887, PRD #999 S3): the TECHNICAL state of sync work,
    // beside the other control-plane coordination tables. The observable outcome
    // stays in the workspace `sync_run` (S1). Mirror control-plane.ts's SCHEMA.
    await client.executeMultiple(`CREATE TABLE IF NOT EXISTS job (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      dedupe_key TEXT NOT NULL,
      workspace_id TEXT,
      payload_json TEXT NOT NULL DEFAULT 'null',
      status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 5,
      run_after TEXT NOT NULL,
      lease_owner TEXT,
      lease_expires_at TEXT,
      last_error_json TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE UNIQUE INDEX IF NOT EXISTS job_active_dedupe
      ON job(dedupe_key) WHERE status IN ('pending', 'leased');
    CREATE INDEX IF NOT EXISTS job_ready ON job(status, run_after);`);
    await writeControlPlaneSchemaVersion(client, 3);
  }
}
