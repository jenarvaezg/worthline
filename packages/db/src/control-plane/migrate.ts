import { randomUUID } from "node:crypto";
import type { Client } from "@libsql/client";
import { createMaintainerAlertLog } from "./maintainer-alert-log";

export const CP_SCHEMA_VERSION = 9;

const SCHEMA_META_TABLE =
  "CREATE TABLE IF NOT EXISTS cp_schema_meta (version INTEGER NOT NULL)";

function isTursoRejectedStatement(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /SQL_PARSE_ERROR|not allowed statement/i.test(message);
}

export async function readControlPlaneSchemaVersion(
  client: Pick<Client, "execute">,
): Promise<number> {
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
  client: Pick<Client, "execute">,
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

/** Registration may name a stub; any vector, metadata or provenance is authored data. */
function hasCuratedCatalogContent(row: Record<string, unknown>): boolean {
  let hasBreakdowns: boolean;
  try {
    const breakdowns = JSON.parse(String(row.breakdowns_json)) as Record<string, unknown>;
    hasBreakdowns = Object.values(breakdowns).some(
      (dimension) =>
        dimension != null &&
        typeof dimension === "object" &&
        Object.keys(dimension).length > 0,
    );
  } catch {
    // Migration preserves legacy data verbatim; unreadable content is never a stub.
    hasBreakdowns = true;
  }
  return (
    hasBreakdowns ||
    [
      "ter",
      "tracked_index",
      "hedged_to_currency",
      "confidence",
      "as_of_date",
      "sources",
    ].some((column) => row[column] != null && String(row[column]).trim() !== "")
  );
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

  if (version < 4) {
    // Entitlements (PRD #1160 S1, #1161): the stored free|trial|premium row
    // beside the grant, plus the per-identity trial marker (#1128) and the
    // set-once activation timestamps (#1131). No backfill: a workspace without
    // a row reads as free with no trial consumed. Mirror control-plane.ts's SCHEMA.
    await client.executeMultiple(`CREATE TABLE IF NOT EXISTS workspace_entitlements (
      workspace_id TEXT PRIMARY KEY,
      plan TEXT NOT NULL DEFAULT 'free',
      trial_ends_at TEXT,
      premium_until TEXT,
      billing_provider TEXT,
      billing_customer_id TEXT,
      subscription_id TEXT,
      subscription_status TEXT,
      onboarded_at TEXT,
      first_holding_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id)
    );
    CREATE TABLE IF NOT EXISTS user_trials (
      user_id TEXT NOT NULL PRIMARY KEY,
      used_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );`);
    await writeControlPlaneSchemaVersion(client, 4);
  }

  if (version < 5) {
    // Billing webhook idempotency (PRD #1160 S5, #1135): one row per delivered
    // provider event id — an insert that loses means "already processed".
    // Mirror control-plane.ts's SCHEMA.
    await client.executeMultiple(`CREATE TABLE IF NOT EXISTS billing_webhook_events (
      provider TEXT NOT NULL,
      event_id TEXT NOT NULL,
      received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (provider, event_id)
    );`);
    await writeControlPlaneSchemaVersion(client, 5);
  }

  if (version < 6) {
    // Per-workspace Turso DB tokens (#1185): each wl-* opens with a token
    // scoped to that database, so a leaked JWT exposes one tenant — not the
    // whole group. Nullable during backfill of pre-#1185 rows.
    // Fresh installs already get the column from SCHEMA's CREATE TABLE; the
    // ALTER is for pre-#1185 control planes. Tolerate the duplicate-column
    // race the same way CREATE IF NOT EXISTS covers other ladder steps.
    try {
      await client.execute("ALTER TABLE workspaces ADD COLUMN db_auth_token TEXT");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Fresh SCHEMA already has the column; synthetic version-only fixtures
      // in ladder tests may lack `workspaces` entirely (CREATE IF NOT EXISTS
      // steps above never needed it). Real control planes always have the table.
      if (
        !/duplicate column name:\s*db_auth_token/i.test(message) &&
        !/no such table:\s*workspaces/i.test(message)
      ) {
        throw err;
      }
    }
    await writeControlPlaneSchemaVersion(client, 6);
  }

  if (version < 7) {
    // Purge poisoned benchmark rows (#1354). Stooq started answering with a
    // JavaScript anti-bot challenge, the CSV parser split that page by commas,
    // and every market-index series ended up with ONE row keyed
    // `date = "(async(-01"` — a fabricated data point the «vs índice» lens has
    // been reading since 2026-07-10. A `date` that is not a real day key is not a
    // row, so it goes; the cron's benchmark phase then re-ingests the real
    // monthly history from Yahoo on its next pass (it only writes months the
    // cache lacks, so the purge is what unblocks the backfill).
    //
    // Idempotent and safe on a healthy control plane: real rows are all
    // `YYYY-MM-DD` and never match.
    try {
      await client.execute(
        `DELETE FROM benchmark_prices
         WHERE date NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'`,
      );
    } catch (err) {
      // Synthetic version-only fixtures in ladder tests may lack the table; a
      // real control plane always has it (SCHEMA creates it).
      const message = err instanceof Error ? err.message : String(err);
      if (!/no such table:\s*benchmark_prices/i.test(message)) {
        throw err;
      }
    }
    await writeControlPlaneSchemaVersion(client, 7);
  }

  if (version < 8) {
    // Catalog provenance (#1508, ADR 0058 amendment): what a vector is worth
    // believing (`confidence`), the cut-off day of the DATA (`as_of_date`) and
    // where it came from (`sources`). Until now the catalog stored WHAT each
    // vector says and nothing about its trustworthiness, so a factsheet read to
    // the decimal and a two-year-old mandate reading were indistinguishable.
    //
    // All three are nullable and there is NO backfill: a pre-#1508 row reads as
    // «sin declarar», which is the truth about it. Fresh installs already get
    // the columns from EXPOSURE_PROFILE_SCHEMA's CREATE TABLE, in this same
    // order, so both paths converge; the ALTERs are for existing control planes
    // and tolerate the duplicate-column race the same way the other steps do.
    for (const column of ["confidence", "as_of_date", "sources"]) {
      try {
        await client.execute(
          `ALTER TABLE global_exposure_profiles ADD COLUMN ${column} TEXT`,
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // Fresh SCHEMA already has the column; synthetic version-only fixtures
        // in ladder tests may lack the table entirely.
        if (
          !new RegExp(`duplicate column name:\\s*${column}`, "i").test(message) &&
          !/no such table:\s*global_exposure_profiles/i.test(message)
        ) {
          throw err;
        }
      }
    }
    await writeControlPlaneSchemaVersion(client, 8);
  }
  if (version < 9) {
    const tx = await client.transaction("write");
    try {
      // Another opener may have completed v9 while this one awaited the lock.
      if ((await readControlPlaneSchemaVersion(tx)) < 9) {
        const tables = await tx.execute(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'global_exposure_profiles'",
        );
        // Synthetic version-only fixtures may lack the catalog altogether.
        if (tables.rows.length > 0) {
          try {
            await tx.execute(
              "ALTER TABLE global_exposure_profiles ADD COLUMN dgs_code TEXT",
            );
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            if (!/duplicate column name:\s*dgs_code/i.test(message)) throw err;
          }
          await tx.execute(`CREATE UNIQUE INDEX IF NOT EXISTS global_exposure_profiles_dgs
            ON global_exposure_profiles(dgs_code) WHERE dgs_code IS NOT NULL`);
          const candidates = await tx.execute(`SELECT * FROM global_exposure_profiles
            WHERE identity_kind = 'provider' AND price_provider = 'finect' ORDER BY rowid`);
          // Stable sort keeps the first curated row canonical and leaves every
          // displaced stub under its original provider identity, with no data loss.
          const plans = candidates.rows.filter((row) =>
            /^N\d{4}$/.test(String(row.provider_symbol).split("-", 1)[0]!),
          );
          plans.sort(
            (left, right) =>
              Number(hasCuratedCatalogContent(right)) -
              Number(hasCuratedCatalogContent(left)),
          );
          for (const row of plans) {
            const code = String(row.provider_symbol).split("-", 1)[0]!;
            const canonical = await tx.execute({
              sql: "SELECT * FROM global_exposure_profiles WHERE identity_key = ?",
              args: [`dgs:${code}`],
            });
            if (canonical.rows.length > 0) {
              if (
                hasCuratedCatalogContent(row) &&
                hasCuratedCatalogContent(canonical.rows[0]!)
              ) {
                await createMaintainerAlertLog(tx, randomUUID).raiseMaintainerAlert({
                  category: "catalog_identity_collision",
                  workspaceId: "catalog",
                  holdingId: `dgs:${code}`,
                  payload: {
                    category: "catalog_identity_collision",
                    dgsCode: code,
                    canonicalIdentityKey: `dgs:${code}`,
                    retainedProviderIdentityKey: String(row.identity_key),
                    reason:
                      "Dos fichas con contenido comparten el mismo código DGS. Se conservan ambas para su revisión.",
                  },
                });
              }
              continue;
            }
            await tx.execute({
              sql: `UPDATE global_exposure_profiles SET identity_key = ?, identity_kind = 'dgs',
                dgs_code = ?, isin = NULL, price_provider = NULL, provider_symbol = NULL WHERE identity_key = ?`,
              args: [`dgs:${code}`, code, String(row.identity_key)],
            });
          }
        }
        await writeControlPlaneSchemaVersion(tx, 9);
      }
      await tx.commit();
    } finally {
      tx.close();
    }
  }
}
