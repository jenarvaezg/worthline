import { createTursoPort } from "@web/turso-port";
import { createControlPlaneStore, provisionWorkspaceForUser } from "@worthline/db";

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
}

export async function provisionWorkspaceForEmail(
  email: string,
  env: Record<string, string | undefined> = process.env,
): Promise<ResolvedWorkspace> {
  const controlPlaneUrl = env["WORTHLINE_CONTROL_PLANE_DB_URL"];
  const groupToken = env["WORTHLINE_DB_AUTH_TOKEN"];
  const tursoOrg = env["TURSO_ORG"];
  const tursoToken = env["TURSO_API_TOKEN"];

  if (!controlPlaneUrl || !tursoOrg || !tursoToken) {
    throw new Error(
      "Hosted provisioning requires WORTHLINE_CONTROL_PLANE_DB_URL, TURSO_ORG, and TURSO_API_TOKEN.",
    );
  }

  const controlPlane = await createControlPlaneStore({
    url: controlPlaneUrl,
    ...(groupToken ? { authToken: groupToken } : {}),
  });
  try {
    const turso = createTursoPort({
      org: tursoOrg,
      token: tursoToken,
      ...(env["TURSO_GROUP"] ? { group: env["TURSO_GROUP"] } : {}),
    });
    const workspace = await provisionWorkspaceForUser(
      {
        controlPlane,
        turso,
        ...(groupToken ? { groupAuthToken: groupToken } : {}),
      },
      email,
    );
    return { id: workspace.id, dbUrl: workspace.dbUrl };
  } finally {
    controlPlane.close();
  }
}
