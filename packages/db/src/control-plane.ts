import { randomUUID } from "node:crypto";

import type { Client } from "@libsql/client";
import type {
  CreateGlobalExposureProfileInput,
  GlobalExposureProfile,
  GlobalExposureProfileBreakdowns,
  GlobalExposureProfileIdentity,
  InvestmentPriceProvider,
  RawGlobalExposureProfileIdentityInput,
  UpdateGlobalExposureProfileInput,
} from "@worthline/domain";
import {
  createValidatedGlobalExposureProfileInput,
  globalExposureProfileIdentityKey,
  resolveGlobalExposureProfileIdentity,
  validateGlobalExposureProfileContent,
} from "@worthline/domain";

import { migrateControlPlane } from "./control-plane-migrate";
import { type LibsqlUrlTarget, openLibsqlClient } from "./libsql-client";

/**
 * The control plane (ADR 0030). A single small libSQL database — separate from
 * every per-workspace database — that maps **users** → **workspaces** →
 * **grants**. It is the only place that knows which workspace a signed-in user
 * owns; each workspace database itself still holds exactly one `id = 'default'`
 * row and knows nothing of users. Provision-on-first-login (see provisioner.ts)
 * writes the workspace + grant rows here.
 */

export interface ControlPlaneUser {
  id: string;
  email: string;
  createdAt: string;
}

export interface ControlPlaneWorkspace {
  id: string;
  dbName: string;
  dbUrl: string;
  createdAt: string;
}

export interface ControlPlaneGrant {
  userId: string;
  workspaceId: string;
  role: string;
  createdAt: string;
}

export interface BenchmarkPrice {
  seriesId: string;
  dateKey: string;
  value: string;
}

export interface ProviderCooldown {
  provider: string;
  cooldownUntil: string;
}

/**
 * The three maintainer-alert categories (#1050, ADR 0064). `infidelity`: the
 * painted/persisted figure diverges from the engine's recomputation (the #1042
 * class of bug). `residual`: an unexplained residual above the documented
 * modeling tolerance after normalizing and verifying config. `sync_source`: the
 * smell is a connected-source/sync ownership problem, not a worthline calc bug.
 */
export type MaintainerAlertCategory = "infidelity" | "residual" | "sync_source";

/** An alert's lifecycle state (#1050): `open` accumulates occurrences; `resolved`/`dismissed` close it. */
export type MaintainerAlertStatus = "open" | "resolved" | "dismissed";

/**
 * One recorded occurrence of a maintainer alert (#1050). Every occurrence carries
 * the FULL forensic payload as opaque JSON — the store never inspects it, so it
 * stays decoupled from the agent-view calculation-trace shape it embeds.
 */
export interface MaintainerAlertOccurrence {
  id: string;
  payload: unknown;
  occurredAt: string;
}

/**
 * A maintainer alert (#1050, decision #1038, ADR 0064): a suspected-bug signal
 * the assistant raised, stored ENTIRELY in the control plane so no workspace
 * export can drag maintainer material out. Dedup key is
 * `workspace_id + holding_id + category`: while one is `open` a re-raise
 * accumulates an occurrence; once closed, a re-raise mints a NEW alert linked
 * back via {@link supersedesAlertId} (it smells like a regression).
 */
export interface MaintainerAlert {
  id: string;
  workspaceId: string;
  holdingId: string;
  category: MaintainerAlertCategory;
  status: MaintainerAlertStatus;
  occurrenceCount: number;
  firstSeenAt: string;
  lastSeenAt: string;
  resolutionNote: string | null;
  resolutionLink: string | null;
  resolvedAt: string | null;
  /** The prior closed alert of the same key this one supersedes (regression link), or null. */
  supersedesAlertId: string | null;
  createdAt: string;
  updatedAt: string;
}

/** An alert with every occurrence's forensic payload — the `/admin` detail read (#1050). */
export interface MaintainerAlertWithOccurrences extends MaintainerAlert {
  occurrences: MaintainerAlertOccurrence[];
}

export interface RaiseMaintainerAlertInput {
  workspaceId: string;
  holdingId: string;
  category: MaintainerAlertCategory;
  /** The forensic payload (config snapshot, calculation trace, declared figure, …); stored verbatim as JSON. */
  payload: unknown;
  /** When the occurrence happened, as ISO; defaults to now. */
  occurredAt?: string;
}

/** The outcome of raising an alert (#1050): the resulting alert and whether a new row was minted. */
export interface RaisedMaintainerAlert {
  alert: MaintainerAlert;
  /** True when a NEW alert was created (first of its key, or a regression after closure). */
  created: boolean;
}

export interface UpdateMaintainerAlertStatusInput {
  status: Exclude<MaintainerAlertStatus, "open">;
  note?: string;
  link?: string;
}

/** A workspace plus its owner's email — the oldest grant; v1 is always exactly
 * one owner per workspace. `ownerEmail` is null only for a dangling workspace
 * with no grant row (should not happen post-provisioning, but the admin
 * surface must not crash on it, #697). */
export interface ControlPlaneWorkspaceWithOwner extends ControlPlaneWorkspace {
  ownerEmail: string | null;
}

export interface ControlPlaneStore {
  /** Idempotent by email: the same address always maps to the same user row. */
  findOrCreateUser(email: string): Promise<ControlPlaneUser>;
  /**
   * Read an existing user by email without creating one — null when unknown.
   * The MCP auth path resolves a caller this way so it never provisions; that
   * stays on first web sign-in (ADR 0030 / ADR 0034).
   */
  findUserByEmail(email: string): Promise<ControlPlaneUser | null>;
  /** Register a freshly provisioned workspace database. */
  createWorkspace(input: {
    dbName: string;
    dbUrl: string;
  }): Promise<ControlPlaneWorkspace>;
  /**
   * Remove a workspace row. The provisioner's loser-side cleanup after losing
   * the first-login race (#733) — the loser never got a grant, so only the
   * workspace row exists.
   */
  deleteWorkspace(workspaceId: string): Promise<void>;
  /** Grant a user access to a workspace (default role `owner`). */
  recordGrant(
    userId: string,
    workspaceId: string,
    role?: string,
  ): Promise<ControlPlaneGrant>;
  /** Read a single grant, or null when the user has no access to the workspace. */
  readGrant(userId: string, workspaceId: string): Promise<ControlPlaneGrant | null>;
  /** Every workspace the user has been granted, oldest grant first. */
  listWorkspacesForUser(userId: string): Promise<ControlPlaneWorkspace[]>;
  /**
   * Every workspace across all users, oldest first. The daily-capture cron's
   * global enumeration seam (ADR 0037) — a system actor with no session, so it
   * lists workspaces directly rather than scoped to a granted user.
   */
  listAllWorkspaces(): Promise<ControlPlaneWorkspace[]>;
  /**
   * A single workspace plus its owner's email, or null when the id is unknown.
   * The admin impersonation seam's lookup (#697): the cookie carries only a
   * workspace id, so resolving "who owns it" (for the banner) and "where does
   * it live" (for the store) both go through this one query.
   */
  getWorkspaceWithOwner(
    workspaceId: string,
  ): Promise<ControlPlaneWorkspaceWithOwner | null>;
  /**
   * Every workspace with its owner's email, oldest first — the admin user list
   * (#697).
   */
  listWorkspacesWithOwners(): Promise<ControlPlaneWorkspaceWithOwner[]>;
  /**
   * Whether this fleet-capture pass has already finalized. The key is an opaque
   * run key, not a bare calendar date: since #895 it is pass-qualified
   * (`YYYY-MM-DD:am|pm`) so the morning and evening passes finalize
   * independently — do not query this table by a plain date and expect a match.
   */
  hasDailyCaptureRun(runKey: string): Promise<boolean>;
  /** Record or update this fleet-capture pass's finalization (see `hasDailyCaptureRun`). */
  recordDailyCaptureRun(runKey: string, finalizedAt: string): Promise<void>;
  /** Benchmark series cached globally in the control plane (ADR 0060). */
  readBenchmarkPrices(seriesId: string): Promise<BenchmarkPrice[]>;
  /** Upsert monthly benchmark rows by `(series_id, date)`. */
  upsertBenchmarkPrices(
    seriesId: string,
    prices: { dateKey: string; value: string }[],
  ): Promise<void>;
  /**
   * Count one shared-baseline chat request and return the running count for
   * (rateKey, windowKey) — the serverless-safe counter behind the assistant's
   * rate limit (ADR 0051). Increment-then-check: the caller compares the
   * returned count against its limit, so the counter needs no policy.
   */
  recordChatRequest(rateKey: string, windowKey: string): Promise<number>;
  /** Cooldowns shared by every serverless instance of one deployment. */
  readProviderCooldowns(deploymentKey: string): Promise<ProviderCooldown[]>;
  /** Monotonic upsert: concurrent failures may extend but never shorten it. */
  recordProviderCooldown(
    deploymentKey: string,
    provider: string,
    cooldownUntil: string,
  ): Promise<void>;
  /**
   * Count one user-triggered connected-source sync for (rateKey, windowKey).
   * Same increment-then-check contract as chat usage, but kept in a separate
   * table so chat and sync quotas cannot interfere.
   */
  recordConnectedSourceSync(rateKey: string, windowKey: string): Promise<number>;
  /** Global exposure-profile catalog (PRD #711 S1 / #940). */
  createGlobalExposureProfile(
    input: CreateGlobalExposureProfileInput,
  ): Promise<GlobalExposureProfile>;
  updateGlobalExposureProfile(
    identity: RawGlobalExposureProfileIdentityInput,
    input: UpdateGlobalExposureProfileInput,
  ): Promise<GlobalExposureProfile>;
  rekeyGlobalExposureProfile(
    from: RawGlobalExposureProfileIdentityInput,
    to: RawGlobalExposureProfileIdentityInput,
  ): Promise<GlobalExposureProfile>;
  deleteGlobalExposureProfile(
    identity: RawGlobalExposureProfileIdentityInput,
  ): Promise<void>;
  readGlobalExposureProfile(
    identity: RawGlobalExposureProfileIdentityInput,
  ): Promise<GlobalExposureProfile | null>;
  readGlobalExposureProfiles(): Promise<GlobalExposureProfile[]>;
  /**
   * Raise a maintainer alert (#1050, ADR 0064). Dedup by
   * `workspaceId + holdingId + category`: an existing OPEN alert of that key
   * accumulates a new occurrence; otherwise a fresh alert is minted, linked to
   * the most recent closed alert of the same key (regression) when one exists.
   */
  raiseMaintainerAlert(input: RaiseMaintainerAlertInput): Promise<RaisedMaintainerAlert>;
  /** Every alert across all workspaces, most-recently-seen first (the `/admin` list). */
  listMaintainerAlerts(): Promise<MaintainerAlert[]>;
  /** One alert with every occurrence's forensic payload, or null when unknown. */
  getMaintainerAlert(alertId: string): Promise<MaintainerAlertWithOccurrences | null>;
  /** Close an alert (`resolved`/`dismissed`) with an optional note/link. Throws when unknown. */
  updateMaintainerAlertStatus(
    alertId: string,
    input: UpdateMaintainerAlertStatusInput,
  ): Promise<MaintainerAlert>;
  /** Count of currently-open alerts — the `/admin` badge. */
  countOpenMaintainerAlerts(): Promise<number>;
  close(): void;
}

export interface ControlPlaneStoreOptions {
  url?: string;
  authToken?: string;
  /** Id generator, injectable so tests stay deterministic. */
  newId?: () => string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  db_name TEXT NOT NULL UNIQUE,
  db_url TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS grants (
  user_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'owner',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, workspace_id),
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id)
);
-- Self-healing for pre-#733 duplicates: demote every owner grant that has an
-- older sibling for the same user (rowid breaks created_at ties), so the
-- unique index below can always be created on an existing database. Matches
-- prior behavior — later logins already picked the oldest grant.
UPDATE grants SET role = 'orphaned-owner'
WHERE role = 'owner' AND EXISTS (
  SELECT 1 FROM grants older
  WHERE older.user_id = grants.user_id AND older.role = 'owner'
    AND (older.created_at < grants.created_at
      OR (older.created_at = grants.created_at AND older.rowid < grants.rowid))
);
-- One owned workspace per user (#733): the database-level arbiter for the
-- provisioner's check-then-create race. Partial so a future sharing flow can
-- still grant the same user other workspaces under non-owner roles.
CREATE UNIQUE INDEX IF NOT EXISTS grants_one_owner_per_user
  ON grants(user_id) WHERE role = 'owner';
CREATE TABLE IF NOT EXISTS daily_capture_runs (
  date_key TEXT PRIMARY KEY,
  finalized_at TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS chat_usage (
  rate_key TEXT NOT NULL,
  window_key TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (rate_key, window_key)
);
CREATE TABLE IF NOT EXISTS provider_cooldowns (
  deployment_key TEXT NOT NULL,
  provider TEXT NOT NULL,
  cooldown_until TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (deployment_key, provider)
);
CREATE TABLE IF NOT EXISTS connected_source_sync_usage (
  rate_key TEXT NOT NULL,
  window_key TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (rate_key, window_key)
);
CREATE TABLE IF NOT EXISTS benchmark_prices (
  series_id TEXT NOT NULL,
  date TEXT NOT NULL,
  value TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (series_id, date)
);
CREATE TABLE IF NOT EXISTS global_exposure_profiles (
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
  WHERE price_provider IS NOT NULL AND provider_symbol IS NOT NULL;
CREATE TABLE IF NOT EXISTS maintainer_alerts (
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
-- At most one OPEN alert per (workspace, holding, category): the arbiter for the
-- dedup contract. Partial so a closed alert never blocks a fresh (regression) one.
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
  ON maintainer_alert_occurrences(alert_id);
`;

function toUser(row: Record<string, unknown>): ControlPlaneUser {
  return {
    id: String(row["id"]),
    email: String(row["email"]),
    createdAt: String(row["created_at"]),
  };
}

function toWorkspace(row: Record<string, unknown>): ControlPlaneWorkspace {
  return {
    id: String(row["id"]),
    dbName: String(row["db_name"]),
    dbUrl: String(row["db_url"]),
    createdAt: String(row["created_at"]),
  };
}

function toGrant(row: Record<string, unknown>): ControlPlaneGrant {
  return {
    userId: String(row["user_id"]),
    workspaceId: String(row["workspace_id"]),
    role: String(row["role"]),
    createdAt: String(row["created_at"]),
  };
}

function toWorkspaceWithOwner(
  row: Record<string, unknown>,
): ControlPlaneWorkspaceWithOwner {
  return {
    ...toWorkspace(row),
    ownerEmail: row["owner_email"] == null ? null : String(row["owner_email"]),
  };
}

function toBenchmarkPrice(row: Record<string, unknown>): BenchmarkPrice {
  return {
    seriesId: String(row["series_id"]),
    dateKey: String(row["date"]),
    value: String(row["value"]),
  };
}

function toMaintainerAlert(row: Record<string, unknown>): MaintainerAlert {
  return {
    id: String(row["id"]),
    workspaceId: String(row["workspace_id"]),
    holdingId: String(row["holding_id"]),
    category: String(row["category"]) as MaintainerAlertCategory,
    status: String(row["status"]) as MaintainerAlertStatus,
    occurrenceCount: Number(row["occurrence_count"]),
    firstSeenAt: String(row["first_seen_at"]),
    lastSeenAt: String(row["last_seen_at"]),
    resolutionNote:
      row["resolution_note"] == null ? null : String(row["resolution_note"]),
    resolutionLink:
      row["resolution_link"] == null ? null : String(row["resolution_link"]),
    resolvedAt: row["resolved_at"] == null ? null : String(row["resolved_at"]),
    supersedesAlertId:
      row["supersedes_alert_id"] == null ? null : String(row["supersedes_alert_id"]),
    createdAt: String(row["created_at"]),
    updatedAt: String(row["updated_at"]),
  };
}

function toMaintainerAlertOccurrence(
  row: Record<string, unknown>,
): MaintainerAlertOccurrence {
  return {
    id: String(row["id"]),
    payload: JSON.parse(String(row["payload_json"])),
    occurredAt: String(row["occurred_at"]),
  };
}

function toGlobalExposureProfileIdentity(
  row: Record<string, unknown>,
): GlobalExposureProfileIdentity {
  const kind = String(row["identity_kind"]);
  if (kind === "isin") {
    return { isin: String(row["isin"]), kind: "isin" };
  }
  return {
    kind: "provider",
    priceProvider: String(row["price_provider"]) as InvestmentPriceProvider,
    providerSymbol: String(row["provider_symbol"]),
  };
}

function toGlobalExposureProfile(row: Record<string, unknown>): GlobalExposureProfile {
  return {
    identity: toGlobalExposureProfileIdentity(row),
    displayName: row["display_name"] == null ? null : String(row["display_name"]),
    breakdowns: JSON.parse(
      String(row["breakdowns_json"]),
    ) as GlobalExposureProfileBreakdowns,
    ter: row["ter"] == null ? null : String(row["ter"]),
    trackedIndex: row["tracked_index"] == null ? null : String(row["tracked_index"]),
    hedgedToCurrency:
      row["hedged_to_currency"] == null ? null : String(row["hedged_to_currency"]),
    createdAt: String(row["created_at"]),
    updatedAt: String(row["updated_at"]),
  };
}

function identityColumns(identity: GlobalExposureProfileIdentity): {
  identityKey: string;
  identityKind: string;
  isin: string | null;
  priceProvider: string | null;
  providerSymbol: string | null;
} {
  if (identity.kind === "isin") {
    return {
      identityKey: globalExposureProfileIdentityKey(identity),
      identityKind: "isin",
      isin: identity.isin,
      priceProvider: null,
      providerSymbol: null,
    };
  }
  return {
    identityKey: globalExposureProfileIdentityKey(identity),
    identityKind: "provider",
    isin: null,
    priceProvider: identity.priceProvider,
    providerSymbol: identity.providerSymbol,
  };
}

/** Correlated subquery: the oldest grant's owner email for a given workspace —
 * shared by the single-workspace and list-all queries below. */
const OWNER_EMAIL_SUBQUERY = `(
  SELECT u.email FROM grants g
  JOIN users u ON u.id = g.user_id
  WHERE g.workspace_id = w.id
  ORDER BY g.created_at ASC
  LIMIT 1
) AS owner_email`;

async function buildControlPlaneStore(
  client: Client,
  newId: () => string,
): Promise<ControlPlaneStore> {
  await client.executeMultiple(SCHEMA);
  await migrateControlPlane(client);

  return {
    async findOrCreateUser(email) {
      const existing = await client.execute({
        sql: "SELECT id, email, created_at FROM users WHERE email = ?",
        args: [email],
      });
      if (existing.rows.length > 0) {
        return toUser(existing.rows[0]!);
      }
      // ON CONFLICT: two concurrent first logins may both pass the select
      // above (#733); whichever insert lands second becomes a no-op and both
      // resolve to the same row via the re-select by email.
      await client.execute({
        sql: "INSERT INTO users (id, email) VALUES (?, ?) ON CONFLICT(email) DO NOTHING",
        args: [newId(), email],
      });
      const created = await client.execute({
        sql: "SELECT id, email, created_at FROM users WHERE email = ?",
        args: [email],
      });
      return toUser(created.rows[0]!);
    },
    async findUserByEmail(email) {
      const result = await client.execute({
        sql: "SELECT id, email, created_at FROM users WHERE email = ?",
        args: [email],
      });
      return result.rows.length > 0 ? toUser(result.rows[0]!) : null;
    },
    async createWorkspace({ dbName, dbUrl }) {
      const id = newId();
      await client.execute({
        sql: "INSERT INTO workspaces (id, db_name, db_url) VALUES (?, ?, ?)",
        args: [id, dbName, dbUrl],
      });
      const created = await client.execute({
        sql: "SELECT id, db_name, db_url, created_at FROM workspaces WHERE id = ?",
        args: [id],
      });
      return toWorkspace(created.rows[0]!);
    },
    async deleteWorkspace(workspaceId) {
      await client.execute({
        sql: "DELETE FROM workspaces WHERE id = ?",
        args: [workspaceId],
      });
    },
    async recordGrant(userId, workspaceId, role = "owner") {
      await client.execute({
        sql: "INSERT INTO grants (user_id, workspace_id, role) VALUES (?, ?, ?)",
        args: [userId, workspaceId, role],
      });
      const created = await client.execute({
        sql: "SELECT user_id, workspace_id, role, created_at FROM grants WHERE user_id = ? AND workspace_id = ?",
        args: [userId, workspaceId],
      });
      return toGrant(created.rows[0]!);
    },
    async readGrant(userId, workspaceId) {
      const result = await client.execute({
        sql: "SELECT user_id, workspace_id, role, created_at FROM grants WHERE user_id = ? AND workspace_id = ?",
        args: [userId, workspaceId],
      });
      return result.rows.length > 0 ? toGrant(result.rows[0]!) : null;
    },
    async listWorkspacesForUser(userId) {
      const result = await client.execute({
        sql: `SELECT w.id, w.db_name, w.db_url, w.created_at
              FROM workspaces w
              JOIN grants g ON g.workspace_id = w.id
              WHERE g.user_id = ?
              ORDER BY g.created_at ASC`,
        args: [userId],
      });
      return result.rows.map((row) => toWorkspace(row));
    },
    async listAllWorkspaces() {
      const result = await client.execute(
        "SELECT id, db_name, db_url, created_at FROM workspaces ORDER BY created_at ASC",
      );
      return result.rows.map((row) => toWorkspace(row));
    },
    async getWorkspaceWithOwner(workspaceId) {
      const result = await client.execute({
        sql: `SELECT w.id, w.db_name, w.db_url, w.created_at, ${OWNER_EMAIL_SUBQUERY}
              FROM workspaces w
              WHERE w.id = ?`,
        args: [workspaceId],
      });
      return result.rows.length > 0 ? toWorkspaceWithOwner(result.rows[0]!) : null;
    },
    async listWorkspacesWithOwners() {
      const result = await client.execute(
        `SELECT w.id, w.db_name, w.db_url, w.created_at, ${OWNER_EMAIL_SUBQUERY}
         FROM workspaces w
         ORDER BY w.created_at ASC`,
      );
      return result.rows.map((row) => toWorkspaceWithOwner(row));
    },
    async hasDailyCaptureRun(dateKey) {
      const result = await client.execute({
        sql: "SELECT 1 FROM daily_capture_runs WHERE date_key = ? LIMIT 1",
        args: [dateKey],
      });
      return result.rows.length > 0;
    },
    async recordDailyCaptureRun(dateKey, finalizedAt) {
      await client.execute({
        sql: `INSERT INTO daily_capture_runs (date_key, finalized_at)
              VALUES (?, ?)
              ON CONFLICT(date_key) DO UPDATE SET
                finalized_at = excluded.finalized_at,
                updated_at = CURRENT_TIMESTAMP`,
        args: [dateKey, finalizedAt],
      });
    },
    async readBenchmarkPrices(seriesId) {
      const result = await client.execute({
        sql: `SELECT series_id, date, value
              FROM benchmark_prices
              WHERE series_id = ?
              ORDER BY date ASC`,
        args: [seriesId],
      });
      return result.rows.map((row) => toBenchmarkPrice(row));
    },
    async upsertBenchmarkPrices(seriesId, prices) {
      for (const price of prices) {
        await client.execute({
          sql: `INSERT INTO benchmark_prices (series_id, date, value)
                VALUES (?, ?, ?)
                ON CONFLICT(series_id, date) DO UPDATE SET
                  value = excluded.value,
                  updated_at = CURRENT_TIMESTAMP`,
          args: [seriesId, price.dateKey, price.value],
        });
      }
    },
    async recordChatRequest(rateKey, windowKey) {
      // ponytail: stale hourly rows are never purged — ~24 tiny rows/day/key;
      // add a sweep if the table ever matters.
      const result = await client.execute({
        sql: `INSERT INTO chat_usage (rate_key, window_key, count)
              VALUES (?, ?, 1)
              ON CONFLICT(rate_key, window_key) DO UPDATE SET
                count = count + 1,
                updated_at = CURRENT_TIMESTAMP
              RETURNING count`,
        args: [rateKey, windowKey],
      });
      return Number(result.rows[0]?.["count"] ?? 1);
    },
    async readProviderCooldowns(deploymentKey) {
      const result = await client.execute({
        sql: `SELECT provider, cooldown_until
              FROM provider_cooldowns
              WHERE deployment_key = ?
              ORDER BY provider ASC`,
        args: [deploymentKey],
      });
      return result.rows.map((row) => ({
        provider: String(row["provider"]),
        cooldownUntil: String(row["cooldown_until"]),
      }));
    },
    async recordProviderCooldown(deploymentKey, provider, cooldownUntil) {
      await client.execute({
        sql: `INSERT INTO provider_cooldowns
                (deployment_key, provider, cooldown_until)
              VALUES (?, ?, ?)
              ON CONFLICT(deployment_key, provider) DO UPDATE SET
                cooldown_until = MAX(cooldown_until, excluded.cooldown_until),
                updated_at = CURRENT_TIMESTAMP`,
        args: [deploymentKey, provider, cooldownUntil],
      });
    },
    async recordConnectedSourceSync(rateKey, windowKey) {
      const result = await client.execute({
        sql: `INSERT INTO connected_source_sync_usage (rate_key, window_key, count)
              VALUES (?, ?, 1)
              ON CONFLICT(rate_key, window_key) DO UPDATE SET
                count = count + 1,
                updated_at = CURRENT_TIMESTAMP
              RETURNING count`,
        args: [rateKey, windowKey],
      });
      return Number(result.rows[0]?.["count"] ?? 1);
    },
    async createGlobalExposureProfile(input) {
      const validated = createValidatedGlobalExposureProfileInput(input);
      const columns = identityColumns(validated.identity);
      const existing = await client.execute({
        sql: "SELECT identity_key FROM global_exposure_profiles WHERE identity_key = ?",
        args: [columns.identityKey],
      });
      if (existing.rows.length > 0) {
        throw new Error("Global exposure profile identity already exists.");
      }

      await client.execute({
        sql: `INSERT INTO global_exposure_profiles (
                identity_key, identity_kind, isin, price_provider, provider_symbol,
                display_name, breakdowns_json, ter, tracked_index, hedged_to_currency
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          columns.identityKey,
          columns.identityKind,
          columns.isin,
          columns.priceProvider,
          columns.providerSymbol,
          validated.displayName,
          JSON.stringify(validated.breakdowns),
          validated.ter,
          validated.trackedIndex,
          validated.hedgedToCurrency,
        ],
      });

      const created = await client.execute({
        sql: "SELECT * FROM global_exposure_profiles WHERE identity_key = ?",
        args: [columns.identityKey],
      });
      return toGlobalExposureProfile(created.rows[0]!);
    },
    async updateGlobalExposureProfile(identityInput, input) {
      const identity = resolveGlobalExposureProfileIdentity(identityInput);
      const validated = validateGlobalExposureProfileContent(input);
      const identityKey = globalExposureProfileIdentityKey(identity);
      const existing = await client.execute({
        sql: "SELECT created_at FROM global_exposure_profiles WHERE identity_key = ?",
        args: [identityKey],
      });
      if (existing.rows.length === 0) {
        throw new Error("Global exposure profile not found.");
      }

      await client.execute({
        sql: `UPDATE global_exposure_profiles SET
                display_name = ?,
                breakdowns_json = ?,
                ter = ?,
                tracked_index = ?,
                hedged_to_currency = ?,
                updated_at = CURRENT_TIMESTAMP
              WHERE identity_key = ?`,
        args: [
          validated.displayName,
          JSON.stringify(validated.breakdowns),
          validated.ter,
          validated.trackedIndex,
          validated.hedgedToCurrency,
          identityKey,
        ],
      });

      const updated = await client.execute({
        sql: "SELECT * FROM global_exposure_profiles WHERE identity_key = ?",
        args: [identityKey],
      });
      const profile = toGlobalExposureProfile(updated.rows[0]!);
      return {
        ...profile,
        createdAt: String(existing.rows[0]!.created_at),
      };
    },
    async rekeyGlobalExposureProfile(fromInput, toInput) {
      const from = resolveGlobalExposureProfileIdentity(fromInput);
      const to = resolveGlobalExposureProfileIdentity(toInput);
      const fromKey = globalExposureProfileIdentityKey(from);
      const toColumns = identityColumns(to);

      const existing = await client.execute({
        sql: "SELECT * FROM global_exposure_profiles WHERE identity_key = ?",
        args: [fromKey],
      });
      if (existing.rows.length === 0) {
        throw new Error("Global exposure profile not found.");
      }

      const collision = await client.execute({
        sql: "SELECT identity_key FROM global_exposure_profiles WHERE identity_key = ?",
        args: [toColumns.identityKey],
      });
      if (collision.rows.length > 0) {
        throw new Error("Global exposure profile identity already exists.");
      }

      const current = existing.rows[0]!;
      await client.execute({
        sql: `UPDATE global_exposure_profiles SET
                identity_key = ?,
                identity_kind = ?,
                isin = ?,
                price_provider = ?,
                provider_symbol = ?,
                updated_at = CURRENT_TIMESTAMP
              WHERE identity_key = ?`,
        args: [
          toColumns.identityKey,
          toColumns.identityKind,
          toColumns.isin,
          toColumns.priceProvider,
          toColumns.providerSymbol,
          fromKey,
        ],
      });

      const rekeyed = await client.execute({
        sql: "SELECT * FROM global_exposure_profiles WHERE identity_key = ?",
        args: [toColumns.identityKey],
      });
      const profile = toGlobalExposureProfile(rekeyed.rows[0]!);
      return {
        ...profile,
        createdAt: String(current.created_at),
      };
    },
    async deleteGlobalExposureProfile(identityInput) {
      const identity = resolveGlobalExposureProfileIdentity(identityInput);
      const identityKey = globalExposureProfileIdentityKey(identity);
      await client.execute({
        sql: "DELETE FROM global_exposure_profiles WHERE identity_key = ?",
        args: [identityKey],
      });
    },
    async readGlobalExposureProfile(identityInput) {
      const identity = resolveGlobalExposureProfileIdentity(identityInput);
      const result = await client.execute({
        sql: "SELECT * FROM global_exposure_profiles WHERE identity_key = ?",
        args: [globalExposureProfileIdentityKey(identity)],
      });
      return result.rows.length > 0 ? toGlobalExposureProfile(result.rows[0]!) : null;
    },
    async readGlobalExposureProfiles() {
      const result = await client.execute(
        `SELECT * FROM global_exposure_profiles
         ORDER BY identity_kind ASC, identity_key ASC`,
      );
      return result.rows.map((row) => toGlobalExposureProfile(row));
    },
    async raiseMaintainerAlert({
      workspaceId,
      holdingId,
      category,
      payload,
      occurredAt,
    }) {
      const stamp = occurredAt ?? new Date().toISOString();
      const payloadJson = JSON.stringify(payload ?? null);

      const open = await client.execute({
        sql: `SELECT * FROM maintainer_alerts
              WHERE workspace_id = ? AND holding_id = ? AND category = ? AND status = 'open'
              LIMIT 1`,
        args: [workspaceId, holdingId, category],
      });

      if (open.rows.length > 0) {
        const alertId = String(open.rows[0]!["id"]);
        await client.execute({
          sql: `INSERT INTO maintainer_alert_occurrences (id, alert_id, payload_json, occurred_at)
                VALUES (?, ?, ?, ?)`,
          args: [newId(), alertId, payloadJson, stamp],
        });
        await client.execute({
          sql: `UPDATE maintainer_alerts SET
                  occurrence_count = occurrence_count + 1,
                  last_seen_at = MAX(last_seen_at, ?),
                  updated_at = CURRENT_TIMESTAMP
                WHERE id = ?`,
          args: [stamp, alertId],
        });
        const reread = await client.execute({
          sql: "SELECT * FROM maintainer_alerts WHERE id = ?",
          args: [alertId],
        });
        return { alert: toMaintainerAlert(reread.rows[0]!), created: false };
      }

      // No open alert of this key: mint a fresh one, linked to the most recent
      // closed alert of the same key (a re-trigger after closure smells like a
      // regression — #1050).
      const priorClosed = await client.execute({
        sql: `SELECT id FROM maintainer_alerts
              WHERE workspace_id = ? AND holding_id = ? AND category = ? AND status != 'open'
              ORDER BY last_seen_at DESC, rowid DESC
              LIMIT 1`,
        args: [workspaceId, holdingId, category],
      });
      const supersedesAlertId =
        priorClosed.rows.length > 0 ? String(priorClosed.rows[0]!["id"]) : null;

      const alertId = newId();
      await client.execute({
        sql: `INSERT INTO maintainer_alerts (
                id, workspace_id, holding_id, category, status, occurrence_count,
                first_seen_at, last_seen_at, supersedes_alert_id
              ) VALUES (?, ?, ?, ?, 'open', 1, ?, ?, ?)`,
        args: [
          alertId,
          workspaceId,
          holdingId,
          category,
          stamp,
          stamp,
          supersedesAlertId,
        ],
      });
      await client.execute({
        sql: `INSERT INTO maintainer_alert_occurrences (id, alert_id, payload_json, occurred_at)
              VALUES (?, ?, ?, ?)`,
        args: [newId(), alertId, payloadJson, stamp],
      });
      const created = await client.execute({
        sql: "SELECT * FROM maintainer_alerts WHERE id = ?",
        args: [alertId],
      });
      return { alert: toMaintainerAlert(created.rows[0]!), created: true };
    },
    async listMaintainerAlerts() {
      const result = await client.execute(
        `SELECT * FROM maintainer_alerts ORDER BY last_seen_at DESC, rowid DESC`,
      );
      return result.rows.map((row) => toMaintainerAlert(row));
    },
    async getMaintainerAlert(alertId) {
      const alert = await client.execute({
        sql: "SELECT * FROM maintainer_alerts WHERE id = ?",
        args: [alertId],
      });
      if (alert.rows.length === 0) return null;
      const occurrences = await client.execute({
        sql: `SELECT id, alert_id, payload_json, occurred_at
              FROM maintainer_alert_occurrences
              WHERE alert_id = ?
              ORDER BY occurred_at ASC, rowid ASC`,
        args: [alertId],
      });
      return {
        ...toMaintainerAlert(alert.rows[0]!),
        occurrences: occurrences.rows.map((row) => toMaintainerAlertOccurrence(row)),
      };
    },
    async updateMaintainerAlertStatus(alertId, { status, note, link }) {
      const existing = await client.execute({
        sql: "SELECT id FROM maintainer_alerts WHERE id = ?",
        args: [alertId],
      });
      if (existing.rows.length === 0) {
        throw new Error("Maintainer alert not found.");
      }
      await client.execute({
        sql: `UPDATE maintainer_alerts SET
                status = ?,
                resolution_note = ?,
                resolution_link = ?,
                resolved_at = CURRENT_TIMESTAMP,
                updated_at = CURRENT_TIMESTAMP
              WHERE id = ?`,
        args: [status, note ?? null, link ?? null, alertId],
      });
      const updated = await client.execute({
        sql: "SELECT * FROM maintainer_alerts WHERE id = ?",
        args: [alertId],
      });
      return toMaintainerAlert(updated.rows[0]!);
    },
    async countOpenMaintainerAlerts() {
      const result = await client.execute(
        "SELECT COUNT(*) AS count FROM maintainer_alerts WHERE status = 'open'",
      );
      return Number(result.rows[0]?.["count"] ?? 0);
    },
    close() {
      client.close();
    },
  };
}

export async function createControlPlaneStore(
  options: ControlPlaneStoreOptions = {},
): Promise<ControlPlaneStore> {
  if (!options.url) {
    throw new Error("createControlPlaneStore requires a url (libsql:// or file:).");
  }
  const target: LibsqlUrlTarget = {
    url: options.url,
    ...(options.authToken ? { authToken: options.authToken } : {}),
  };
  return buildControlPlaneStore(openLibsqlClient(target), options.newId ?? randomUUID);
}

/** Open an ephemeral in-memory control plane — for tests. */
export async function createInMemoryControlPlaneStore(
  options: Pick<ControlPlaneStoreOptions, "newId"> = {},
): Promise<ControlPlaneStore> {
  return buildControlPlaneStore(
    openLibsqlClient(":memory:"),
    options.newId ?? randomUUID,
  );
}
