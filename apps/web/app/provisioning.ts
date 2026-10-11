import { buildProvisioningCapAlert } from "@web/admin/provisioning-cap-alert";
import { withControlPlaneStore } from "@web/control-plane-store";
import {
  PROVISIONING_CLOSED_LOGIN_PATH,
  readDailyProvisioningCap,
} from "@web/provisioning-cap";
import { handOffSignInWorkspace, takeSignInWorkspace } from "@web/sign-in-handoff";
import { createTursoPort } from "@web/turso-port";
import {
  type ControlPlaneStore,
  DailyProvisioningCapRefusedError,
  type ProvisionDeps,
  provisionWorkspaceForUser,
  type TursoPort,
} from "@worthline/db";

/**
 * Hosted provision-on-first-login wiring (ADR 0030). Composes the control-plane
 * store (one libSQL database, env-configured) with the real Turso Platform port,
 * and resolves the signed-in user's workspace — creating and migrating a fresh
 * one on first login. Runs only in the Node runtime (the Auth.js callbacks);
 * the local no-auth build never reaches it.
 *
 * Creating a NEW workspace passes the daily provisioning cap (#1175): when it
 * refuses, the sign-in is turned away honestly and the maintainer gets an alert
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
 * daily provisioning cap refuses to create one. Raises the maintainer alert on
 * a refusal; any other failure propagates.
 */
export async function resolveWorkspaceForSignIn(
  email: string,
  env: Env = process.env,
  overrides: ProvisioningOverrides = {},
): Promise<SignInWorkspaceOutcome> {
  const provisioningCap = readDailyProvisioningCap(env);
  const now = overrides.now ?? (() => new Date().toISOString());

  return withControlPlaneStore<SignInWorkspaceOutcome, ProvisioningControlPlane>(
    async (controlPlane) => {
      const turso = overrides.turso ?? tursoPortFromEnv(env);
      try {
        const workspace = await provisionWorkspaceForUser(
          {
            controlPlane,
            now,
            provisioningCap,
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
        if (!(error instanceof DailyProvisioningCapRefusedError)) throw error;
        await raiseCapAlertBestEffort(controlPlane, {
          detectedAt: now(),
          refusal: error.refusal,
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
 * The Auth.js `signIn` decision (#1175, ADR 0110): `true` lets the sign-in
 * through with its workspace provisioned; a path refuses it and sends the person
 * there. It runs in `signIn` rather than `jwt` because only `signIn` can
 * redirect — a refusal raised from `jwt` would surface as Auth.js's generic
 * server-error page, which is not an honest way to say «hoy estamos llenos».
 * The resolved workspace is handed to this request's `jwt` callback.
 */
export async function admitSignIn(
  email: string,
  env: Env = process.env,
  overrides: ProvisioningOverrides = {},
): Promise<true | string> {
  const outcome = await resolveWorkspaceForSignIn(email, env, overrides);
  if (outcome.kind === "closed") return PROVISIONING_CLOSED_LOGIN_PATH;
  handOffSignInWorkspace(email, outcome.workspace);
  return true;
}

/**
 * The workspace the `jwt` callback pins into the session token: the one
 * {@link admitSignIn} handed off in this same request, so a login opens the
 * control plane once. Without a handoff (a path that bypasses the auth route)
 * it resolves the workspace itself — slower, same answer: `signIn` has already
 * provisioned it, and an existing user is never refused. A refusal here would
 * need the workspace to vanish between the two callbacks, so it is a failure.
 */
export async function workspaceForSessionToken(
  email: string,
  env: Env = process.env,
  overrides: ProvisioningOverrides = {},
): Promise<ResolvedWorkspace> {
  const handedOff = takeSignInWorkspace(email);
  if (handedOff) return handedOff;
  const outcome = await resolveWorkspaceForSignIn(email, env, overrides);
  if (outcome.kind === "closed") {
    throw new Error(
      "The signed-in identity has no workspace and the daily provisioning cap refused one.",
    );
  }
  return outcome.workspace;
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
