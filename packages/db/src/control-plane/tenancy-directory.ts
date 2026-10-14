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
  db_read_only_token TEXT,
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
-- prior behavior — later logins already picked the oldest grant. The demoted
-- role is not a GrantRole, so it grants nothing (#1841, ADR 0112).
UPDATE grants SET role = 'orphaned-owner'
WHERE role = 'owner' AND EXISTS (
  SELECT 1 FROM grants older
  WHERE older.user_id = grants.user_id AND older.role = 'owner'
    AND (older.created_at < grants.created_at
      OR (older.created_at = grants.created_at AND older.rowid < grants.rowid))
);
-- One owned workspace per user (#733): the database-level arbiter for the
-- provisioner's check-then-create race. Partial so the same user can still be
-- granted other workspaces as a viewer (#1841, ADR 0112).
CREATE UNIQUE INDEX IF NOT EXISTS grants_one_owner_per_user
  ON grants(user_id) WHERE role = 'owner';
`;

/**
 * The roles a grant can carry (#1841, ADR 0112). `owner` opens the workspace
 * with the full token; `viewer` opens it read-only. Any other stored value — the
 * legacy `orphaned-owner` the #733 healing writes among them — grants nothing.
 */
export const GRANT_ROLES = ["owner", "viewer"] as const;
export type GrantRole = (typeof GRANT_ROLES)[number];

/** Fail-closed reading of a stored role: anything but a known role is null. */
export function parseGrantRole(value: unknown): GrantRole | null {
  return GRANT_ROLES.find((role) => role === value) ?? null;
}

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
  /**
   * Whether the workspace already has a read-only Turso token (#1841). Only the
   * presence travels here: the token itself is read through
   * {@link TenancyDirectory.readViewerAccess}, and only for a viewer.
   */
  hasReadOnlyToken: boolean;
  createdAt: string;
}

export interface ControlPlaneGrant {
  userId: string;
  workspaceId: string;
  role: GrantRole;
  createdAt: string;
}

/** A workspace plus its owner's email — the oldest `owner` grant (#1841: a
 * viewer is never the owner). `ownerEmail` is null for a dangling workspace with
 * no owner grant (should not happen post-provisioning, but the admin surface
 * must not crash on it, #697). */
export interface ControlPlaneWorkspaceWithOwner extends ControlPlaneWorkspace {
  ownerEmail: string | null;
}

/** One viewer of a workspace, for its owner's list (#1841). */
export interface WorkspaceViewer {
  userId: string;
  email: string;
  createdAt: string;
}

/** A workspace someone else owns and shared with this user (#1841). */
export interface WorkspaceSharedWithUser {
  workspaceId: string;
  ownerEmail: string;
  createdAt: string;
}

/**
 * What a viewer needs to open a shared workspace read-only (#1841): where it
 * lives and the read-only token. Never the full token.
 */
export interface ViewerAccess {
  workspaceId: string;
  dbUrl: string;
  readOnlyToken: string;
  ownerEmail: string;
  viewerEmail: string;
}

/**
 * Tenancy directory (ADR 0030): users → workspaces → grants. The only concern
 * that knows which workspace a signed-in user owns, and who may view it
 * (ADR 0112).
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
   * Persist (or replace) the workspace's read-only Turso JWT (#1841), sealed at
   * rest exactly like `db_auth_token`.
   */
  setWorkspaceReadOnlyToken(workspaceId: string, readOnlyToken: string): Promise<void>;
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
    role?: GrantRole,
  ): Promise<ControlPlaneGrant>;
  /**
   * Read a single grant, or null when the user has no access to the workspace —
   * including a row whose role is not a {@link GrantRole} (fail closed).
   */
  readGrant(userId: string, workspaceId: string): Promise<ControlPlaneGrant | null>;
  /**
   * The workspaces the user OWNS (`role = 'owner'`), oldest grant first — at
   * most one, by `grants_one_owner_per_user`. The only resolution the
   * provisioner and the MCP use, so a viewer grant can never come back as owned
   * (#1841, ADR 0112). No method returns owned and shared workspaces together.
   */
  listOwnedWorkspacesForUser(userId: string): Promise<ControlPlaneWorkspace[]>;
  /** The viewers of a workspace, oldest grant first — never its owner (#1841). */
  listViewersOfWorkspace(workspaceId: string): Promise<WorkspaceViewer[]>;
  /**
   * The workspaces other people own and shared with this user, oldest grant
   * first (#1841). A workspace with no owner grant is not listed.
   */
  listWorkspacesSharedWithUser(userId: string): Promise<WorkspaceSharedWithUser[]>;
  /**
   * The read-only access of `viewerEmail` to `workspaceId`, in one query, or
   * null unless a `viewer` grant exists AND the workspace has a read-only token
   * (#1841). The email is compared trimmed and lower-cased. Never returns the
   * full token.
   */
  readViewerAccess(input: {
    viewerEmail: string;
    workspaceId: string;
  }): Promise<ViewerAccess | null>;
  /**
   * Remove a viewer grant. Only ever deletes a `role = 'viewer'` row, so the
   * owner's grant survives even when called with the owner's id. True when a
   * grant was removed.
   */
  revokeViewerGrant(workspaceId: string, userId: string): Promise<boolean>;
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

/** The workspace columns every workspace read selects, from `workspaces w`. */
const WORKSPACE_COLUMNS = `w.id, w.db_name, w.db_url, w.db_auth_token, w.created_at,
  (w.db_read_only_token IS NOT NULL AND w.db_read_only_token != '') AS has_read_only_token`;

/** Correlated subquery: the oldest OWNER grant's email for a given workspace —
 * shared by every query that names a workspace's owner. Filtering the role is
 * what keeps a viewer from ever reading as the owner (#1841): impersonation,
 * billing, trial emails and the sync queue all resolve the owner through it. */
const OWNER_EMAIL_SUBQUERY = `(
  SELECT ou.email FROM grants og
  JOIN users ou ON ou.id = og.user_id
  WHERE og.workspace_id = w.id AND og.role = 'owner'
  ORDER BY og.created_at ASC, og.rowid ASC
  LIMIT 1
) AS owner_email`;

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
    hasReadOnlyToken: Number(row["has_read_only_token"]) === 1,
    createdAt: String(row["created_at"]),
  };
}

/** A grant row, or null when its role is not a {@link GrantRole} (fail closed). */
function toGrant(row: Record<string, unknown>): ControlPlaneGrant | null {
  const role = parseGrantRole(row["role"]);
  if (!role) return null;
  return {
    userId: String(row["user_id"]),
    workspaceId: String(row["workspace_id"]),
    role,
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

/** Trimmed and lower-cased: the one comparable form of an email address. */
function comparableEmail(email: string): string {
  return email.trim().toLowerCase();
}

const GRANT_COLUMNS = "user_id, workspace_id, role, created_at";

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
        sql: `SELECT ${WORKSPACE_COLUMNS} FROM workspaces w WHERE w.id = ?`,
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
    async setWorkspaceReadOnlyToken(workspaceId, readOnlyToken) {
      await client.execute({
        sql: "UPDATE workspaces SET db_read_only_token = ? WHERE id = ?",
        args: [sealSecret(readOnlyToken), workspaceId],
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
      const grant = await readGrantRow(client, userId, workspaceId);
      if (!grant) {
        throw new Error(`recordGrant: the ${role} grant just written is unreadable.`);
      }
      return grant;
    },
    async readGrant(userId, workspaceId) {
      return readGrantRow(client, userId, workspaceId);
    },
    async listOwnedWorkspacesForUser(userId) {
      const result = await client.execute({
        sql: `SELECT ${WORKSPACE_COLUMNS}
              FROM workspaces w
              JOIN grants g ON g.workspace_id = w.id
              WHERE g.user_id = ? AND g.role = 'owner'
              ORDER BY g.created_at ASC, g.rowid ASC`,
        args: [userId],
      });
      return result.rows.map((row) => toWorkspace(row));
    },
    async listViewersOfWorkspace(workspaceId) {
      const result = await client.execute({
        sql: `SELECT u.id AS user_id, u.email, g.created_at
              FROM grants g
              JOIN users u ON u.id = g.user_id
              WHERE g.workspace_id = ? AND g.role = 'viewer'
              ORDER BY g.created_at ASC, g.rowid ASC`,
        args: [workspaceId],
      });
      return result.rows.map((row) => ({
        createdAt: String(row["created_at"]),
        email: String(row["email"]),
        userId: String(row["user_id"]),
      }));
    },
    async listWorkspacesSharedWithUser(userId) {
      const result = await client.execute({
        sql: `SELECT workspace_id, created_at, owner_email FROM (
                SELECT w.id AS workspace_id, g.created_at, g.rowid AS grant_rowid,
                  ${OWNER_EMAIL_SUBQUERY}
                FROM grants g
                JOIN workspaces w ON w.id = g.workspace_id
                WHERE g.user_id = ? AND g.role = 'viewer'
              )
              WHERE owner_email IS NOT NULL
              ORDER BY created_at ASC, grant_rowid ASC`,
        args: [userId],
      });
      return result.rows.map((row) => ({
        createdAt: String(row["created_at"]),
        ownerEmail: String(row["owner_email"]),
        workspaceId: String(row["workspace_id"]),
      }));
    },
    async readViewerAccess({ viewerEmail, workspaceId }) {
      const result = await client.execute({
        sql: `SELECT id, db_url, db_read_only_token, viewer_email, owner_email FROM (
                SELECT w.id, w.db_url, w.db_read_only_token, u.email AS viewer_email,
                  ${OWNER_EMAIL_SUBQUERY}
                FROM grants g
                JOIN users u ON u.id = g.user_id
                JOIN workspaces w ON w.id = g.workspace_id
                WHERE g.workspace_id = ? AND g.role = 'viewer'
                  AND lower(u.email) = ?
                  AND w.db_read_only_token IS NOT NULL AND w.db_read_only_token != ''
              )
              WHERE owner_email IS NOT NULL
              LIMIT 1`,
        args: [workspaceId, comparableEmail(viewerEmail)],
      });
      const row = result.rows[0];
      if (!row) return null;
      return {
        dbUrl: String(row["db_url"]),
        ownerEmail: String(row["owner_email"]),
        readOnlyToken: openSecret(String(row["db_read_only_token"])),
        viewerEmail: String(row["viewer_email"]),
        workspaceId: String(row["id"]),
      };
    },
    async revokeViewerGrant(workspaceId, userId) {
      const result = await client.execute({
        sql: "DELETE FROM grants WHERE workspace_id = ? AND user_id = ? AND role = 'viewer'",
        args: [workspaceId, userId],
      });
      return result.rowsAffected > 0;
    },
    async listAllWorkspaces() {
      const result = await client.execute(
        `SELECT ${WORKSPACE_COLUMNS} FROM workspaces w ORDER BY w.created_at ASC`,
      );
      return result.rows.map((row) => toWorkspace(row));
    },
    async getWorkspaceWithOwner(workspaceId) {
      const result = await client.execute({
        sql: `SELECT ${WORKSPACE_COLUMNS}, ${OWNER_EMAIL_SUBQUERY}
              FROM workspaces w
              WHERE w.id = ?`,
        args: [workspaceId],
      });
      return result.rows.length > 0 ? toWorkspaceWithOwner(result.rows[0]!) : null;
    },
    async listWorkspacesWithOwners() {
      const result = await client.execute(
        `SELECT ${WORKSPACE_COLUMNS}, ${OWNER_EMAIL_SUBQUERY}
         FROM workspaces w
         ORDER BY w.created_at ASC`,
      );
      return result.rows.map((row) => toWorkspaceWithOwner(row));
    },
  };
}

async function readGrantRow(
  client: Client,
  userId: string,
  workspaceId: string,
): Promise<ControlPlaneGrant | null> {
  const result = await client.execute({
    sql: `SELECT ${GRANT_COLUMNS} FROM grants WHERE user_id = ? AND workspace_id = ?`,
    args: [userId, workspaceId],
  });
  return result.rows.length > 0 ? toGrant(result.rows[0]!) : null;
}
