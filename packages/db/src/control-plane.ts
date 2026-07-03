import { randomUUID } from "node:crypto";

import type { Client } from "@libsql/client";

import { openLibsqlClient, type LibsqlUrlTarget } from "./libsql-client";

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
  /** Whether the daily fleet capture has already finalized this UTC date. */
  hasDailyCaptureRun(dateKey: string): Promise<boolean>;
  /** Record or update daily fleet capture finalization for this UTC date. */
  recordDailyCaptureRun(dateKey: string, finalizedAt: string): Promise<void>;
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
CREATE TABLE IF NOT EXISTS daily_capture_runs (
  date_key TEXT PRIMARY KEY,
  finalized_at TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
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

  return {
    async findOrCreateUser(email) {
      const existing = await client.execute({
        sql: "SELECT id, email, created_at FROM users WHERE email = ?",
        args: [email],
      });
      if (existing.rows.length > 0) {
        return toUser(existing.rows[0]!);
      }
      const id = newId();
      await client.execute({
        sql: "INSERT INTO users (id, email) VALUES (?, ?)",
        args: [id, email],
      });
      const created = await client.execute({
        sql: "SELECT id, email, created_at FROM users WHERE id = ?",
        args: [id],
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
