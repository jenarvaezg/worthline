/**
 * One-off backfill: seed the global exposure-profile catalog with an EMPTY stub
 * for every market holding that already exists, across all workspaces (#1097,
 * ADR 0058 amendment). Going forward the stub is born with the holding; this
 * script covers the holdings that predate that seam so the admin does not have to
 * wait for each to be re-touched or re-synced.
 *
 * Mechanic: open the control plane, list every workspace, open each workspace DB,
 * read its investment assets, derive each one's catalog identity
 * (`deriveExposureCatalogIdentity`), dedupe across all workspaces, and register a
 * stub via `ensureGlobalExposureProfileStub`. Non-market holdings derive to no
 * identity and are skipped. Idempotent + non-destructive: an existing row (curated
 * or a prior stub) is left untouched, so re-running changes nothing.
 *
 * TARGETS THE PRODUCTION CONTROL PLANE + THE REAL WORKSPACE DBs on Turso. It reads
 * holdings but only ever writes empty stub rows to the control-plane catalog.
 *
 * Usage — DRY-RUN is the default; NOTHING is written without --apply. Run via the
 * package script, which points tsx at the alias tsconfig so the full @db source
 * graph resolves. The env is the same the app reads (apps/web/.env.local): the
 * control-plane URL + the Turso token that opens the control plane and every wl-* DB.
 *
 *   bun run backfill:catalog-stubs               # dry-run
 *   bun run backfill:catalog-stubs -- --apply    # write the stubs
 *
 * with WORTHLINE_CONTROL_PLANE_DB_URL + WORTHLINE_DB_AUTH_TOKEN in the environment
 * (e.g. `env $(grep -v '^#' apps/web/.env.local | xargs) bun run backfill:catalog-stubs`).
 */
import {
  type ControlPlaneStore,
  type ControlPlaneWorkspace,
  createControlPlaneStore,
  createWorthlineStoreUnsafe,
  type WorthlineStore,
} from "@worthline/db";
import {
  deriveExposureCatalogIdentity,
  type GlobalExposureProfileIdentity,
  globalExposureProfileIdentityKey,
} from "@worthline/domain";

const apply = process.argv.includes("--apply");
const controlPlaneUrl = process.env.WORTHLINE_CONTROL_PLANE_DB_URL;
const authToken = process.env.WORTHLINE_DB_AUTH_TOKEN;

if (!controlPlaneUrl) {
  console.error(
    "✗ Set WORTHLINE_CONTROL_PLANE_DB_URL (the control-plane DB the app reads).",
  );
  process.exit(1);
}
if (!authToken) {
  console.error(
    "✗ Set WORTHLINE_DB_AUTH_TOKEN (the Turso token for the control plane + wl-* DBs).",
  );
  process.exit(1);
}

interface DerivedStub {
  identity: GlobalExposureProfileIdentity;
  displayName: string | null;
}

/** Derive every market holding's catalog identity in one workspace DB. */
async function stubsForWorkspace(
  workspace: ControlPlaneWorkspace,
): Promise<DerivedStub[]> {
  let store: WorthlineStore;
  try {
    store = await createWorthlineStoreUnsafe({
      authToken: authToken!,
      url: workspace.dbUrl,
    });
  } catch (error) {
    console.warn(
      `  ! ${workspace.id}: cannot open DB (${(error as Error).message}) — skipped.`,
    );
    return [];
  }

  try {
    const assets = await store.assets.readInvestmentAssetsWithMeta();
    const stubs: DerivedStub[] = [];
    for (const asset of assets) {
      // No instrument on the meta row — `readInvestmentAssetsWithMeta` returns only
      // market investments, so the caller vouches for the market set and supplies
      // the asset's own provider (mirrors the statement-confirm path).
      const identity = deriveExposureCatalogIdentity({
        isin: asset.isin ?? null,
        priceProvider: asset.priceProvider,
        providerSymbol: asset.providerSymbol ?? null,
      });
      if (identity) {
        stubs.push({ displayName: asset.name, identity });
      }
    }
    return stubs;
  } finally {
    store.close();
  }
}

async function main(): Promise<void> {
  console.log(`\nMode: ${apply ? "APPLY (writing stubs)" : "DRY-RUN (no writes)"}`);
  console.log(`Control plane: ${controlPlaneUrl}\n`);

  const controlPlane: ControlPlaneStore = await createControlPlaneStore({
    authToken: authToken!,
    url: controlPlaneUrl!,
  });

  try {
    // The identity keys already in the catalog (curated OR prior stubs) — so the
    // report can tell new stubs from ones that already exist, and --apply only
    // touches the genuinely new ones.
    const existingKeys = new Set(
      (await controlPlane.readGlobalExposureProfiles()).map((profile) =>
        globalExposureProfileIdentityKey(profile.identity),
      ),
    );
    console.log(`Catalog rows before: ${existingKeys.size}`);

    const workspaces = await controlPlane.listAllWorkspaces();
    console.log(`Workspaces to scan:  ${workspaces.length}\n`);

    // Dedupe every derived identity across all workspaces; the first display name
    // wins (a later blank never clobbers a name).
    const byKey = new Map<string, DerivedStub>();
    for (const workspace of workspaces) {
      const stubs = await stubsForWorkspace(workspace);
      let fresh = 0;
      for (const stub of stubs) {
        const key = globalExposureProfileIdentityKey(stub.identity);
        if (!byKey.has(key)) {
          byKey.set(key, stub);
          if (!existingKeys.has(key)) fresh += 1;
        } else if (byKey.get(key)!.displayName === null && stub.displayName !== null) {
          byKey.set(key, stub);
        }
      }
      console.log(
        `  ${workspace.id}: ${stubs.length} market holdings, ${fresh} new identities`,
      );
    }

    const toCreate = [...byKey.entries()].filter(([key]) => !existingKeys.has(key));
    console.log(
      `\nDistinct market identities: ${byKey.size}  |  already in catalog: ${byKey.size - toCreate.length}  |  ${apply ? "creating" : "would create"}: ${toCreate.length}`,
    );

    for (const [, stub] of toCreate.slice(0, 20)) {
      const label =
        stub.identity.kind === "isin" ? stub.identity.isin : stub.identity.providerSymbol;
      console.log(`  + ${label}${stub.displayName ? `  (${stub.displayName})` : ""}`);
    }
    if (toCreate.length > 20) console.log(`  … and ${toCreate.length - 20} more`);

    if (apply) {
      let written = 0;
      for (const [, stub] of toCreate) {
        try {
          await controlPlane.ensureGlobalExposureProfileStub(
            stub.identity,
            stub.displayName,
          );
          written += 1;
        } catch (error) {
          console.error(
            `  ✗ failed to register ${globalExposureProfileIdentityKey(stub.identity)}: ${(error as Error).message}`,
          );
        }
      }
      console.log(
        `\nWrote ${written} stub rows. Catalog rows after: ${existingKeys.size + written}.`,
      );
    } else {
      console.log(
        "\nDRY-RUN only — nothing written. Re-run with --apply to create the stubs.",
      );
    }
  } finally {
    controlPlane.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
