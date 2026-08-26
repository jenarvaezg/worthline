import { openSecret, sealSecret } from "@db/crypto";
import type { Client } from "@libsql/client";

/** Tables owned by the tenancy port (ADR 0030): users → workspaces → grants. */
export const TENANCY_SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  db_name TEXT NOT NULL UNIQUE,
  db_url TEXT NOT NULL,
  db_auth_token TEXT,
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
`;

export interface ControlPlaneUser {
  id: string;
  email: string;
  createdAt: string;
}

export interface ControlPlaneWorkspace {
  id: string;
  dbName: string;
  dbUrl: string;
  /**
   * Per-database Turso JWT (#1185), or null for a pre-#1185 workspace that has
   * not been backfilled yet. Callers that open the workspace DB must prefer this
   * over the shared group token; the group token remains only as a temporary
   * fallback until every row is filled.
   */
  dbAuthToken: string | null;
  createdAt: string;
}

export interface ControlPlaneGrant {
  userId: string;
  workspaceId: string;
  role: string;
  createdAt: string;
}

/** A workspace plus its owner's email — the oldest grant; v1 is always exactly
 * one owner per workspace. `ownerEmail` is null only for a dangling workspace
 * with no grant row (should not happen post-provisioning, but the admin
 * surface must not crash on it, #697). */
export interface ControlPlaneWorkspaceWithOwner extends ControlPlaneWorkspace {
  ownerEmail: string | null;
}

/**
 * Tenancy directory (ADR 0030): users → workspaces → grants. The only concern
 * that knows which workspace a signed-in user owns.
 */
export interface TenancyDirectory {
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
    /** Per-database Turso JWT (#1185). Omitted/undefined stores null (legacy). */
    dbAuthToken?: string | null;
  }): Promise<ControlPlaneWorkspace>;
  /**
   * Persist (or replace) the per-database Turso JWT for an existing workspace
   * (#1185 backfill). Sealed at rest when `WORTHLINE_ENCRYPTION_KEY` is set.
   */
  setWorkspaceDbAuthToken(workspaceId: string, dbAuthToken: string): Promise<void>;
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
}

function toUser(row: Record<string, unknown>): ControlPlaneUser {
  return {
    id: String(row["id"]),
    email: String(row["email"]),
    createdAt: String(row["created_at"]),
  };
}

function toWorkspace(row: Record<string, unknown>): ControlPlaneWorkspace {
  const sealed = row["db_auth_token"];
  return {
    id: String(row["id"]),
    dbName: String(row["db_name"]),
    dbUrl: String(row["db_url"]),
    dbAuthToken: sealed == null || sealed === "" ? null : openSecret(String(sealed)),
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

/** Correlated subquery: the oldest grant's owner email for a given workspace —
 * shared by the single-workspace and list-all queries below. */
const OWNER_EMAIL_SUBQUERY = `(
  SELECT u.email FROM grants g
  JOIN users u ON u.id = g.user_id
  WHERE g.workspace_id = w.id
  ORDER BY g.created_at ASC
  LIMIT 1
) AS owner_email`;

export function createTenancyDirectory(
  client: Client,
  newId: () => string,
): TenancyDirectory {
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
    async createWorkspace({ dbName, dbUrl, dbAuthToken }) {
      const id = newId();
      const sealed =
        dbAuthToken == null || dbAuthToken === "" ? null : sealSecret(dbAuthToken);
      await client.execute({
        sql: "INSERT INTO workspaces (id, db_name, db_url, db_auth_token) VALUES (?, ?, ?, ?)",
        args: [id, dbName, dbUrl, sealed],
      });
      const created = await client.execute({
        sql: "SELECT id, db_name, db_url, db_auth_token, created_at FROM workspaces WHERE id = ?",
        args: [id],
      });
      return toWorkspace(created.rows[0]!);
    },
    async setWorkspaceDbAuthToken(workspaceId, dbAuthToken) {
      await client.execute({
        sql: "UPDATE workspaces SET db_auth_token = ? WHERE id = ?",
        args: [sealSecret(dbAuthToken), workspaceId],
      });
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
        sql: `SELECT w.id, w.db_name, w.db_url, w.db_auth_token, w.created_at
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
        "SELECT id, db_name, db_url, db_auth_token, created_at FROM workspaces ORDER BY created_at ASC",
      );
      return result.rows.map((row) => toWorkspace(row));
    },
    async getWorkspaceWithOwner(workspaceId) {
      const result = await client.execute({
        sql: `SELECT w.id, w.db_name, w.db_url, w.db_auth_token, w.created_at, ${OWNER_EMAIL_SUBQUERY}
              FROM workspaces w
              WHERE w.id = ?`,
        args: [workspaceId],
      });
      return result.rows.length > 0 ? toWorkspaceWithOwner(result.rows[0]!) : null;
    },
    async listWorkspacesWithOwners() {
      const result = await client.execute(
        `SELECT w.id, w.db_name, w.db_url, w.db_auth_token, w.created_at, ${OWNER_EMAIL_SUBQUERY}
         FROM workspaces w
         ORDER BY w.created_at ASC`,
      );
      return result.rows.map((row) => toWorkspaceWithOwner(row));
    },
  };
}
