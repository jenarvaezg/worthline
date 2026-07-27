/**
 * One-off backfill: mint a per-database Turso JWT for every control-plane
 * workspace that still lacks one (#1185). Going forward, provision-on-first-
 * login creates the scoped token with the database; this script covers the
 * workspaces that predate that seam so the shared group token
 * (`WORTHLINE_DB_AUTH_TOKEN`) can stop being a data-plane master key.
 *
 * Mechanic: open the control plane, list every workspace, skip rows that
 * already have `db_auth_token`, call Turso Platform `databases.createToken`
 * for the rest, and persist via `setWorkspaceDbAuthToken` (sealed at rest when
 * `WORTHLINE_ENCRYPTION_KEY` is set). Idempotent: re-running skips filled rows.
 *
 * TARGETS THE PRODUCTION CONTROL PLANE + THE TURSO PLATFORM API. It does not
 * open workspace DBs; it only writes the auth-token column on `workspaces`.
 *
 * Usage — DRY-RUN is the default; NOTHING is written without --apply.
 *
 *   bun run backfill:workspace-db-tokens               # dry-run
 *   bun run backfill:workspace-db-tokens -- --apply    # mint + store
 *
 * Requires WORTHLINE_CONTROL_PLANE_DB_URL, WORTHLINE_DB_AUTH_TOKEN (control
 * plane only), TURSO_ORG, and TURSO_API_TOKEN.
 *
 * After every workspace has a scoped token, rotate the Turso *group* token
 * (invalidate + recreate) and update `WORTHLINE_DB_AUTH_TOKEN` in deploy env
 * so any previously leaked group JWT stops opening workspace DBs. The new
 * group token remains required for the control plane and Platform-adjacent
 * opens; it is no longer the key that unlocks every tenant.
 *
 * Operators should then ask users to re-sign-in (or clear sessions) so JWTs
 * pick up the scoped `dbAuthToken` claim; MCP/cron/sync already re-read the
 * control plane and need no session refresh.
 */
import { createTursoPort } from "@web/turso-port";
import { type ControlPlaneStore, createControlPlaneStore } from "@worthline/db";

const apply = process.argv.includes("--apply");
const controlPlaneUrl = process.env.WORTHLINE_CONTROL_PLANE_DB_URL;
const authToken = process.env.WORTHLINE_DB_AUTH_TOKEN;
const tursoOrg = process.env.TURSO_ORG;
const tursoApiToken = process.env.TURSO_API_TOKEN;
const tursoGroup = process.env.TURSO_GROUP;

if (!controlPlaneUrl) {
  console.error(
    "✗ Set WORTHLINE_CONTROL_PLANE_DB_URL (the control-plane DB the app reads).",
  );
  process.exit(1);
}
if (!authToken) {
  console.error(
    "✗ Set WORTHLINE_DB_AUTH_TOKEN (Turso token for the control plane only).",
  );
  process.exit(1);
}
if (!tursoOrg || !tursoApiToken) {
  console.error("✗ Set TURSO_ORG and TURSO_API_TOKEN (Platform API for minting).");
  process.exit(1);
}

const turso = createTursoPort({
  org: tursoOrg,
  token: tursoApiToken,
  ...(tursoGroup ? { group: tursoGroup } : {}),
});

async function main(): Promise<void> {
  const controlPlane: ControlPlaneStore = await createControlPlaneStore({
    url: controlPlaneUrl!,
    authToken: authToken!,
  });
  try {
    const workspaces = await controlPlane.listAllWorkspaces();
    const missing = workspaces.filter((w) => !w.dbAuthToken);
    const already = workspaces.length - missing.length;

    console.log(
      `${apply ? "APPLY" : "DRY-RUN"} · ${workspaces.length} workspace(s), ${already} already have a scoped token, ${missing.length} to mint.`,
    );

    let minted = 0;
    for (const workspace of missing) {
      if (!apply) {
        console.log(`  · would mint token for ${workspace.dbName} (${workspace.id})`);
        continue;
      }
      const { jwt } = await turso.createDatabaseToken(workspace.dbName);
      await controlPlane.setWorkspaceDbAuthToken(workspace.id, jwt);
      minted += 1;
      console.log(`  ✓ ${workspace.dbName} (${workspace.id})`);
    }

    if (apply) {
      console.log(`Done. Minted ${minted} token(s).`);
      console.log(
        "Next: rotate the Turso group token and update WORTHLINE_DB_AUTH_TOKEN so old group JWTs stop opening workspace DBs.",
      );
    } else {
      console.log("Re-run with --apply to mint and store the tokens.");
    }
  } finally {
    controlPlane.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
