import { withControlPlaneStore } from "@web/control-plane-store";
import { createTursoPort } from "@web/turso-port";
import { provisionWorkspaceForUser } from "@worthline/db";

/**
 * Hosted provision-on-first-login wiring (ADR 0030). Composes the control-plane
 * store (one libSQL database, env-configured) with the real Turso Platform port,
 * and resolves the signed-in user's workspace — creating and migrating a fresh
 * one on first login. Runs only in the Node runtime (the Auth.js `jwt` callback);
 * the local no-auth build never reaches it.
 */

export interface ResolvedWorkspace {
  id: string;
  dbUrl: string;
  /** Per-database Turso JWT (#1185), or null until a legacy row is backfilled. */
  dbAuthToken: string | null;
}

export async function provisionWorkspaceForEmail(
  email: string,
  env: Record<string, string | undefined> = process.env,
): Promise<ResolvedWorkspace> {
  const controlPlaneUrl = env["WORTHLINE_CONTROL_PLANE_DB_URL"];
  const tursoOrg = env["TURSO_ORG"];
  const tursoToken = env["TURSO_API_TOKEN"];

  if (!controlPlaneUrl || !tursoOrg || !tursoToken) {
    throw new Error(
      "Hosted provisioning requires WORTHLINE_CONTROL_PLANE_DB_URL, TURSO_ORG, and TURSO_API_TOKEN.",
    );
  }

  return withControlPlaneStore(
    async (controlPlane) => {
      const turso = createTursoPort({
        org: tursoOrg,
        token: tursoToken,
        ...(env["TURSO_GROUP"] ? { group: env["TURSO_GROUP"] } : {}),
      });
      const workspace = await provisionWorkspaceForUser({ controlPlane, turso }, email);
      return {
        id: workspace.id,
        dbUrl: workspace.dbUrl,
        dbAuthToken: workspace.dbAuthToken,
      };
    },
    { env, purpose: "Hosted provisioning" },
  );
}
