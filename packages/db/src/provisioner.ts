import { randomUUID } from "node:crypto";

import type { ControlPlaneStore, ControlPlaneWorkspace } from "./control-plane";
import { openLibsqlClient } from "./libsql-client";
import { migrate } from "./migrate";

/**
 * Provision-on-first-login (ADR 0030). A signed-in Google identity with no
 * workspace gets a fresh, structurally-isolated one: create a database via the
 * Turso Platform API, migrate it to the current schema, then write the
 * `workspaces` + `grants` rows in the control plane. Idempotent — a user who
 * already owns a workspace keeps it, and no new database is created.
 *
 * The Turso Platform API is injected as a port so the whole flow runs in tests
 * against a local `file:` database with zero network.
 */

export interface TursoPort {
  /** Create a database and return its name and libSQL URL. */
  createDatabase(name: string): Promise<{ name: string; url: string }>;
  /**
   * Delete a database created by this port — best-effort cleanup of the
   * loser's orphan after a first-login race (#733). Optional: without it the
   * orphan database simply lingers, which was the pre-#733 status quo.
   */
  deleteDatabase?(name: string): Promise<void>;
}

export interface ProvisionDeps {
  controlPlane: ControlPlaneStore;
  turso: TursoPort;
  /** Shared Turso group token used to open `libsql://` workspace databases. */
  groupAuthToken?: string;
  /**
   * Open the freshly created workspace database and run its migrations.
   * Injectable for tests; defaults to opening the URL and running `migrate`.
   */
  openAndMigrate?: (target: { url: string; authToken?: string }) => Promise<void>;
  /** Workspace database-name generator, injectable for determinism. */
  newDbName?: () => string;
}

function defaultDbName(): string {
  return `wl-${randomUUID().replaceAll("-", "").slice(0, 16)}`;
}

async function defaultOpenAndMigrate(target: {
  url: string;
  authToken?: string;
}): Promise<void> {
  const client = openLibsqlClient({
    url: target.url,
    ...(target.authToken ? { authToken: target.authToken } : {}),
  });
  try {
    await migrate(client);
  } finally {
    client.close();
  }
}

export async function provisionWorkspaceForUser(
  deps: ProvisionDeps,
  email: string,
): Promise<ControlPlaneWorkspace> {
  const {
    controlPlane,
    turso,
    groupAuthToken,
    openAndMigrate = defaultOpenAndMigrate,
    newDbName = defaultDbName,
  } = deps;

  const user = await controlPlane.findOrCreateUser(email);

  const existing = await controlPlane.listWorkspacesForUser(user.id);
  if (existing.length > 0) {
    return existing[0]!;
  }

  const { name, url } = await turso.createDatabase(newDbName());
  await openAndMigrate({
    url,
    ...(groupAuthToken ? { authToken: groupAuthToken } : {}),
  });
  const workspace = await controlPlane.createWorkspace({
    dbName: name,
    dbUrl: url,
  });
  try {
    await controlPlane.recordGrant(user.id, workspace.id);
  } catch (error) {
    if (!isUniqueConstraintError(error)) {
      throw error;
    }
    // Lost the first-login race (#733): a concurrent provision already owns a
    // grant for this user (grants_one_owner_per_user). Clean up our orphan
    // and hand back the winner's workspace so both logins converge.
    try {
      await controlPlane.deleteWorkspace(workspace.id);
      await turso.deleteDatabase?.(name);
    } catch {
      // Best-effort: a dangling workspace row / database is the pre-#733
      // failure mode and the admin surface tolerates it (#697).
    }
    const [winner] = await controlPlane.listWorkspacesForUser(user.id);
    if (!winner) {
      throw error;
    }
    return winner;
  }
  return workspace;
}

function isUniqueConstraintError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as { code?: unknown }).code;
  return (
    (typeof code === "string" && code.startsWith("SQLITE_CONSTRAINT")) ||
    /UNIQUE constraint failed/i.test(error.message) ||
    /UNIQUE constraint failed/i.test(String((error as { cause?: unknown }).cause ?? ""))
  );
}
