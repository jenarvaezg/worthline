import { randomUUID } from "node:crypto";

import type {
  ControlPlaneWorkspace,
  EntitlementDirectory,
  TenancyDirectory,
} from "./control-plane";
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
  controlPlane: TenancyDirectory & EntitlementDirectory;
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
  /** The reference "now" (ISO) for the trial window — injectable for tests. */
  now?: () => string;
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
    now = () => new Date().toISOString(),
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
    if (!isOwnerGrantConflict(error)) {
      throw error;
    }
    // Lost the first-login race (#733): a concurrent provision already owns a
    // grant for this user (grants_one_owner_per_user). Clean up our orphan
    // and hand back the winner's workspace so both logins converge. Each
    // cleanup is independently best-effort: a dangling workspace row is the
    // pre-#733 failure mode the admin surface tolerates (#697), and a
    // lingering database only costs until an operator acts on the warning.
    try {
      await controlPlane.deleteWorkspace(workspace.id);
    } catch (cleanupError) {
      console.warn(
        `provisioner: could not delete orphan workspace row ${workspace.id} after losing the first-login race`,
        cleanupError,
      );
    }
    if (turso.deleteDatabase) {
      try {
        await turso.deleteDatabase(name);
      } catch (cleanupError) {
        console.warn(
          `provisioner: could not delete orphan database ${name} after losing the first-login race`,
          cleanupError,
        );
      }
    }
    const [winner] = await controlPlane.listWorkspacesForUser(user.id);
    if (!winner) {
      throw error;
    }
    return winner;
  }
  await startTrialBestEffort(controlPlane, user.id, workspace.id, now());
  return workspace;
}

/**
 * A fresh provision starts the identity's one trial (#1128, PRD #1160 S1) —
 * `startTrialIfUnused` is set-once per user, so a re-provisioned identity never
 * re-trials, and pre-#1161 workspaces (which never pass through here) stay free.
 * Best-effort: a failure must not fail the login — the workspace simply reads
 * as `free` (the safe default) and the admin's manual grant is the recovery
 * palanca, matching the provisioner's other warn-and-continue cleanups.
 */
async function startTrialBestEffort(
  controlPlane: EntitlementDirectory,
  userId: string,
  workspaceId: string,
  now: string,
): Promise<void> {
  try {
    await controlPlane.startTrialIfUnused({ now, userId, workspaceId });
  } catch (error) {
    console.warn(
      `provisioner: could not start the trial for workspace ${workspaceId}; it stays free (admin grant is the recovery)`,
      error,
    );
  }
}

/**
 * Only the grants_one_owner_per_user violation counts as "lost the race" —
 * the message text is the most transport-stable signal (the local driver and
 * remote hrana both embed SQLite's "UNIQUE constraint failed: grants.user_id").
 * Anything else (FK violations, other tables) must propagate, not trigger
 * cleanup of a legitimately created workspace.
 */
function isOwnerGrantConflict(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const text = `${error.message} ${String((error as { cause?: unknown }).cause ?? "")}`;
  return /UNIQUE constraint failed: grants\.user_id/i.test(text);
}
