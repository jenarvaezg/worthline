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
  await controlPlane.recordGrant(user.id, workspace.id);
  return workspace;
}
