import { buildProvisioningCapAlert } from "@web/admin/provisioning-cap-alert";
import { withControlPlaneStore } from "@web/control-plane-store";
import {
  effectiveDailyProvisioningCap,
  PROVISIONING_CLOSED_LOGIN_PATH,
  readDailyProvisioningCap,
} from "@web/provisioning-cap";
import { createTursoPort } from "@web/turso-port";
import {
  type ControlPlaneStore,
  type ProvisionDeps,
  provisionWorkspaceForUser,
  type TursoPort,
  WorkspaceProvisioningClosedError,
} from "@worthline/db";

/**
 * Hosted provision-on-first-login wiring (ADR 0030). Composes the control-plane
 * store (one libSQL database, env-configured) with the real Turso Platform port,
 * and resolves the signed-in user's workspace — creating and migrating a fresh
 * one on first login. Runs only in the Node runtime (the Auth.js callbacks);
 * the local no-auth build never reaches it.
 *
 * Creating a NEW workspace passes the daily provisioning cap (#1175): when the
 * day is full the sign-in is refused honestly and the maintainer gets an alert
 * (ADR 0064). A returning user never meets the cap.
 */

export interface ResolvedWorkspace {
  id: string;
  dbUrl: string;
  /** Per-database Turso JWT (#1185), or null until a legacy row is backfilled. */
  dbAuthToken: string | null;
}

export type SignInWorkspaceOutcome =
  | { kind: "ready"; workspace: ResolvedWorkspace }
  | { kind: "closed" };

/** The control-plane ports one sign-in touches. */
type ProvisioningControlPlane = ProvisionDeps["controlPlane"] &
  Pick<ControlPlaneStore, "raiseMaintainerAlert">;

/**
 * Seams for tests: a control plane the caller owns (never closed here), a Turso
 * port, the clock, and the migration. Production passes none of them.
 */
export interface ProvisioningOverrides {
  controlPlane?: ProvisioningControlPlane;
  turso?: TursoPort;
  now?: () => string;
  openAndMigrate?: ProvisionDeps["openAndMigrate"];
}

type Env = Record<string, string | undefined>;

/**
 * The signed-in identity's workspace, or `closed` when it owns none and the
 * day's provisioning cap refuses to create one. Raises the maintainer alert on
 * a refusal; any other failure propagates.
 */
export async function resolveWorkspaceForSignIn(
  email: string,
  env: Env = process.env,
  overrides: ProvisioningOverrides = {},
): Promise<SignInWorkspaceOutcome> {
  const capPolicy = readDailyProvisioningCap(env);
  const now = overrides.now ?? (() => new Date().toISOString());

  return withControlPlaneStore<SignInWorkspaceOutcome, ProvisioningControlPlane>(
    async (controlPlane) => {
      const turso = overrides.turso ?? tursoPortFromEnv(env);
      try {
        const workspace = await provisionWorkspaceForUser(
          {
            controlPlane,
            dailyProvisioningCap: effectiveDailyProvisioningCap(capPolicy),
            now,
            turso,
            ...(overrides.openAndMigrate
              ? { openAndMigrate: overrides.openAndMigrate }
              : {}),
          },
          email,
        );
        return {
          kind: "ready",
          workspace: {
            dbAuthToken: workspace.dbAuthToken,
            dbUrl: workspace.dbUrl,
            id: workspace.id,
          },
        };
      } catch (error) {
        if (!(error instanceof WorkspaceProvisioningClosedError)) throw error;
        await raiseCapAlertBestEffort(controlPlane, {
          detectedAt: now(),
          reason: capPolicy.kind === "misconfigured" ? "misconfigured" : "cap_reached",
          refusal: { dailyCap: error.dailyCap, dayKey: error.dayKey, used: error.used },
          ...(capPolicy.kind === "misconfigured"
            ? { configuredValue: capPolicy.raw }
            : {}),
        });
        return { kind: "closed" };
      }
    },
    {
      env,
      purpose: "Hosted provisioning",
      ...(overrides.controlPlane ? { injectedStore: overrides.controlPlane } : {}),
    },
  );
}

/**
 * The workspace to pin into the session token. Called from the `jwt` callback
 * AFTER {@link admitSignIn} has already provisioned, so in practice it resolves
 * an existing workspace; a refusal here (the cap closing between the two
 * callbacks would need the workspace to vanish in between) is a failure.
 */
export async function provisionWorkspaceForEmail(
  email: string,
  env: Env = process.env,
  overrides: ProvisioningOverrides = {},
): Promise<ResolvedWorkspace> {
  const outcome = await resolveWorkspaceForSignIn(email, env, overrides);
  if (outcome.kind === "closed") {
    throw new Error("Workspace provisioning is closed for this identity today.");
  }
  return outcome.workspace;
}

/**
 * The Auth.js `signIn` decision (#1175): `true` lets the sign-in through with
 * its workspace provisioned; a path refuses it and sends the person there. It
 * runs in `signIn` rather than `jwt` because only `signIn` can redirect — a
 * refusal raised from `jwt` would surface as Auth.js's generic server-error
 * page, which is not an honest way to say «hoy estamos llenos».
 */
export async function admitSignIn(
  email: string,
  env: Env = process.env,
  overrides: ProvisioningOverrides = {},
): Promise<true | string> {
  const outcome = await resolveWorkspaceForSignIn(email, env, overrides);
  return outcome.kind === "ready" ? true : PROVISIONING_CLOSED_LOGIN_PATH;
}

function tursoPortFromEnv(env: Env): TursoPort {
  const tursoOrg = env["TURSO_ORG"];
  const tursoToken = env["TURSO_API_TOKEN"];
  if (!env["WORTHLINE_CONTROL_PLANE_DB_URL"] || !tursoOrg || !tursoToken) {
    throw new Error(
      "Hosted provisioning requires WORTHLINE_CONTROL_PLANE_DB_URL, TURSO_ORG, and TURSO_API_TOKEN.",
    );
  }
  return createTursoPort({
    org: tursoOrg,
    token: tursoToken,
    ...(env["TURSO_GROUP"] ? { group: env["TURSO_GROUP"] } : {}),
  });
}

/**
 * The refusal is already decided and already honest; the alert is the
 * maintainer's copy of it. A control-plane hiccup here must not turn «hoy
 * estamos llenos» into a server error.
 */
async function raiseCapAlertBestEffort(
  controlPlane: Pick<ControlPlaneStore, "raiseMaintainerAlert">,
  input: Parameters<typeof buildProvisioningCapAlert>[0],
): Promise<void> {
  try {
    await controlPlane.raiseMaintainerAlert(buildProvisioningCapAlert(input));
  } catch (error) {
    console.warn(
      `provisioning: could not raise the provisioning-cap alert for ${input.refusal.dayKey}; the sign-up was refused anyway`,
      error,
    );
  }
}
