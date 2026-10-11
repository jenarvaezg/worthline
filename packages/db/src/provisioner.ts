import { randomUUID } from "node:crypto";

import type {
  ControlPlaneWorkspace,
  DailyProvisioningCap,
  EntitlementDirectory,
  TenancyDirectory,
} from "./control-plane";
import { openLibsqlClient } from "./libsql-client";
import { migrate } from "./migrate";

/**
 * Provision-on-first-login (ADR 0030). A signed-in Google identity with no
 * workspace gets a fresh, structurally-isolated one: create a database via the
 * Turso Platform API, mint a per-database auth token (#1185), migrate it to the
 * current schema, then write the `workspaces` + `grants` rows in the control
 * plane. Idempotent — a user who already owns a workspace keeps it, and no new
 * database is created.
 *
 * Creating a NEW workspace is metered by the **daily provisioning cap** (#1175,
 * the fuse #733 left as the future of open registration). The cap only ever
 * stands between a new identity and its first workspace; a returning user is
 * resolved before it is consulted.
 *
 * The Turso Platform API is injected as a port so the whole flow runs in tests
 * against a local `file:` database with zero network.
 */

export interface TursoPort {
  /** Create a database and return its name and libSQL URL. */
  createDatabase(name: string): Promise<{ name: string; url: string }>;
  /**
   * Mint a JWT scoped to a single database (#1185). Prefer this over a shared
   * group token when opening that workspace's libSQL URL.
   */
  createDatabaseToken(name: string): Promise<{ jwt: string }>;
  /**
   * Delete a database created by this port — best-effort cleanup of the
   * loser's orphan after a first-login race (#733). Optional: without it the
   * orphan database simply lingers, which was the pre-#733 status quo.
   */
  deleteDatabase?(name: string): Promise<void>;
}

/**
 * How the daily provisioning cap is set for this deployment (#1175). The
 * deployment reads it from its environment; the provisioner only enforces it.
 *
 * - `uncapped`: no cap — open registration, the #733 default outside production.
 * - `limited`: at most `limit` new workspaces per UTC day; 0 closes registration.
 * - `misconfigured`: the variable is set but is not a non-negative integer.
 * - `unset`: a production deploy without the variable.
 *
 * The last two fail CLOSED (a limit of 0): an operator who meant a fuse must
 * not lose it to a typo or to a forgotten variable.
 */
export type DailyProvisioningCapPolicy =
  | { kind: "uncapped" }
  | { kind: "limited"; limit: number }
  | { kind: "misconfigured"; configuredValue: string }
  | { kind: "unset" };

/** Every policy that can refuse — all of them but `uncapped`. */
export type EnforcedDailyProvisioningCap = Exclude<
  DailyProvisioningCapPolicy,
  { kind: "uncapped" }
>;

/** Why and when the cap refused a new workspace — what the alert is built from. */
export interface DailyProvisioningCapRefusal {
  /** The UTC day (`YYYY-MM-DD`) the cap counted against. */
  dayKey: string;
  /** The policy that refused, whole, so the reason travels with it. */
  policy: EnforcedDailyProvisioningCap;
  /** Workspaces that day had already provisioned. */
  provisionedToday: number;
}

/** The limit a policy enforces; the fail-closed kinds admit nothing. */
export function dailyProvisioningLimit(policy: EnforcedDailyProvisioningCap): number {
  return policy.kind === "limited" ? policy.limit : 0;
}

export interface ProvisionDeps {
  controlPlane: TenancyDirectory & EntitlementDirectory & DailyProvisioningCap;
  turso: TursoPort;
  /**
   * The daily provisioning cap in force (#1175); `uncapped` when omitted. Only
   * NEW workspaces are metered: an identity that already owns one is resolved
   * before the cap is ever consulted.
   */
  provisioningCap?: DailyProvisioningCapPolicy;
  /**
   * @deprecated #1185 — workspace DBs open with a per-database token. Kept
   * optional only so older call sites compile; the provisioner ignores it.
   */
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

/**
 * The daily provisioning cap refused (#1175): this identity owns no workspace
 * and none may be created for it today. Nothing was written — no database, no
 * user row — so the refusal costs nothing and leaves no trace of who asked.
 * The caller turns it into the honest «hoy estamos llenos» and the maintainer
 * alert; it is an expected outcome, not a failure.
 */
export class DailyProvisioningCapRefusedError extends Error {
  readonly refusal: DailyProvisioningCapRefusal;

  constructor(refusal: DailyProvisioningCapRefusal) {
    super(
      `The daily provisioning cap (${refusal.policy.kind}) refused a new workspace on ${refusal.dayKey}: ${refusal.provisionedToday} already provisioned.`,
    );
    this.name = "DailyProvisioningCapRefusedError";
    this.refusal = refusal;
  }
}

/** The UTC calendar day an instant falls on — the cap's window (#1175). */
function utcDayKey(isoInstant: string): string {
  return new Date(isoInstant).toISOString().slice(0, 10);
}

export async function provisionWorkspaceForUser(
  deps: ProvisionDeps,
  email: string,
): Promise<ControlPlaneWorkspace> {
  const { controlPlane, provisioningCap = { kind: "uncapped" }, now = defaultNow } = deps;

  // A returning identity is resolved BEFORE the cap is consulted, and with a
  // read that creates nothing: whatever the day's count, an existing user's
  // sign-in never touches the cap (#1175).
  const known = await controlPlane.findUserByEmail(email);
  if (known) {
    const [existing] = await controlPlane.listWorkspacesForUser(known.id);
    if (existing) {
      return existing;
    }
  }

  if (provisioningCap.kind === "uncapped") {
    return (await createOwnedWorkspace(deps, email)).workspace;
  }

  // A new workspace: ask the day's cap before spending anything. The claim is
  // the atomic arbiter, so two sign-ups racing for the last place cannot both
  // get through; the loser leaves without a database or a user row.
  const dayKey = utcDayKey(now());
  const claim = await controlPlane.claimDailyProvisioning(
    dayKey,
    dailyProvisioningLimit(provisioningCap),
  );
  if (!claim.admitted) {
    throw new DailyProvisioningCapRefusedError({
      dayKey,
      policy: provisioningCap,
      provisionedToday: claim.provisionedToday,
    });
  }

  // From here on the day counts this workspace, and must stop counting it
  // whenever no NEW workspace comes out of the claim: a provision that fails (a
  // Turso outage must not eat the day's cap) or one that converged on the
  // winner of the #733 same-identity race (a double-click is one sign-up).
  let outcome: { workspace: ControlPlaneWorkspace; created: boolean };
  try {
    outcome = await createOwnedWorkspace(deps, email);
  } catch (error) {
    await releaseClaimBestEffort(controlPlane, dayKey);
    throw error;
  }
  if (!outcome.created) {
    await releaseClaimBestEffort(controlPlane, dayKey);
  }
  return outcome.workspace;
}

function defaultNow(): string {
  return new Date().toISOString();
}

/**
 * Give an admitted claim back to the day it was claimed on. Best-effort: the
 * sign-in's outcome is already decided, and a claim that fails to come back
 * only makes the day's cap one tighter until midnight — never looser.
 */
async function releaseClaimBestEffort(
  controlPlane: DailyProvisioningCap,
  dayKey: string,
): Promise<void> {
  try {
    await controlPlane.releaseDailyProvisioning(dayKey);
  } catch (error) {
    console.warn(
      `provisioner: could not give back a daily provisioning claim of ${dayKey}; the day's cap stays one tighter`,
      error,
    );
  }
}

/**
 * Create the identity's workspace: database, scoped token, migration, then the
 * control-plane rows. `created` is false when a concurrent first login of the
 * same identity won the grant (#733) and its workspace is handed back instead.
 */
async function createOwnedWorkspace(
  deps: ProvisionDeps,
  email: string,
): Promise<{ workspace: ControlPlaneWorkspace; created: boolean }> {
  const {
    controlPlane,
    turso,
    openAndMigrate = defaultOpenAndMigrate,
    newDbName = defaultDbName,
    now = defaultNow,
  } = deps;

  const user = await controlPlane.findOrCreateUser(email);

  // Re-checked here, right before the cost: a concurrent first login of the
  // same identity may have finished since the caller's read.
  const [existing] = await controlPlane.listWorkspacesForUser(user.id);
  if (existing) {
    return { workspace: existing, created: false };
  }

  const { name, url } = await turso.createDatabase(newDbName());
  const { jwt } = await turso.createDatabaseToken(name);
  await openAndMigrate({
    url,
    authToken: jwt,
  });
  const workspace = await controlPlane.createWorkspace({
    dbName: name,
    dbUrl: url,
    dbAuthToken: jwt,
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
    return { workspace: winner, created: false };
  }
  await startTrialBestEffort(controlPlane, user.id, workspace.id, now());
  return { workspace, created: true };
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
