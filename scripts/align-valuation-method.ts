/**
 * One-off sweep (#1680): align the dead `valuation_method` columns with the method
 * the holding itself derives, across every workspace.
 *
 * The columns are a leftover of the v13 backfill that nothing decides with any more
 * — an asset's method comes from its INSTRUMENT (`valuationMethodOfAsset`, ADR 0014)
 * and a liability's from its DEBT MODEL (`valuationMethodOfLiability`). The seams
 * that still read the columns (the balance-reconciliation guard, the document export,
 * the document import) were moved onto those derivations. What the columns still hold
 * is stale: the audit that opened this ticket found a «Colección Numista» — a
 * connected coin collection, `derived` by ADR 0016 — carrying `stored`, which walked
 * straight through the guard.
 *
 * Mechanic: open the control plane, list every workspace, open each workspace DB with
 * a plain libSQL client, read the classifying columns of `assets` and `liabilities`,
 * and UPDATE only the rows whose stored method differs from the derived one. It writes
 * ONE column per row and nothing else: this value enters no valuation, so there is no
 * curve to re-ripple and no snapshot to rebuild. Idempotent — a second run reports
 * zero rows.
 *
 * Usage — DRY-RUN is the default; NOTHING is written without --apply. Run via the
 * package script, which points tsx at the alias tsconfig so the @db/@domain source
 * graph resolves.
 *
 *   bun run align:valuation-method               # report the drift
 *   bun run align:valuation-method -- --apply    # write the aligned columns
 *
 * with WORTHLINE_CONTROL_PLANE_DB_URL + WORTHLINE_DB_AUTH_TOKEN in the environment
 * (e.g. `env $(grep -v '^#' apps/web/.env.local | xargs) bun run align:valuation-method`).
 */
import type { Client } from "@libsql/client";
import {
  type ControlPlaneStore,
  type ControlPlaneWorkspace,
  createControlPlaneStore,
  openLibsqlClient,
} from "@worthline/db";
import type {
  AssetType,
  DebtModel,
  Instrument,
  ValuationMethod,
} from "@worthline/domain";
import { valuationMethodOfAsset, valuationMethodOfLiability } from "@worthline/domain";

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

interface AssetRow {
  id: string;
  name: string;
  type: AssetType;
  is_primary_residence: number;
  instrument: Instrument | null;
  valuation_method: string | null;
}

interface LiabilityRow {
  id: string;
  name: string;
  debt_model: DebtModel | null;
  valuation_method: string | null;
}

/** Write the aligned method, or just report it in dry-run. */
async function realign(
  client: Client,
  table: "assets" | "liabilities",
  row: { id: string; name: string; valuation_method: string | null },
  derived: ValuationMethod,
  label: string,
): Promise<void> {
  console.log(`  ${row.name} (${label}): ${row.valuation_method ?? "NULL"} → ${derived}`);
  if (!apply) return;
  await client.execute({
    args: [derived, row.id],
    sql: `UPDATE ${table} SET valuation_method = ? WHERE id = ?`,
  });
}

/** Report the drifting rows of one workspace, writing them when --apply is set. */
async function sweepWorkspace(workspace: ControlPlaneWorkspace): Promise<number> {
  const client = openLibsqlClient({ authToken: authToken!, url: workspace.dbUrl });
  try {
    let drifted = 0;

    const assetRows = (
      await client.execute(
        "SELECT id, name, type, is_primary_residence, instrument, valuation_method FROM assets",
      )
    ).rows as unknown as AssetRow[];
    for (const row of assetRows) {
      const derived = valuationMethodOfAsset({
        instrument: row.instrument,
        isPrimaryResidence: row.is_primary_residence === 1,
        type: row.type,
      });
      if (row.valuation_method === derived) continue;
      drifted += 1;
      await realign(client, "assets", row, derived, row.instrument ?? `type:${row.type}`);
    }

    const liabilityRows = (
      await client.execute(
        "SELECT id, name, debt_model, valuation_method FROM liabilities",
      )
    ).rows as unknown as LiabilityRow[];
    for (const row of liabilityRows) {
      const derived = valuationMethodOfLiability(row.debt_model);
      if (row.valuation_method === derived) continue;
      drifted += 1;
      await realign(
        client,
        "liabilities",
        row,
        derived,
        `model:${row.debt_model ?? "none"}`,
      );
    }

    return drifted;
  } finally {
    client.close();
  }
}

async function main(): Promise<void> {
  console.log(`\nMode: ${apply ? "APPLY (writing the column)" : "DRY-RUN (no writes)"}`);
  console.log(`Control plane: ${controlPlaneUrl}\n`);

  const controlPlane: ControlPlaneStore = await createControlPlaneStore({
    authToken: authToken!,
    url: controlPlaneUrl!,
  });

  try {
    const workspaces = await controlPlane.listAllWorkspaces();
    console.log(`Workspaces to sweep: ${workspaces.length}\n`);

    let total = 0;
    let skipped = 0;
    for (const workspace of workspaces) {
      console.log(`· ${workspace.id}`);
      try {
        total += await sweepWorkspace(workspace);
      } catch (error) {
        skipped += 1;
        console.warn(
          `  ! cannot open DB (${(error as Error).message}) — skipped, NOT swept.`,
        );
      }
    }

    console.log(
      `\n${total} row(s) ${apply ? "aligned" : "would be aligned"}` +
        (total === 0 ? " — the columns are coherent everywhere." : "."),
    );
    if (!apply && total > 0) console.log("Re-run with --apply to write.");
    // A skipped workspace is NOT a clean audit: say so, and leave a non-zero exit so
    // nobody reads the run as «all five came out clean».
    if (skipped > 0) {
      console.error(
        `\n✗ ${skipped} workspace(s) could not be opened — the sweep is incomplete.`,
      );
      process.exitCode = 1;
    }
  } finally {
    controlPlane.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
