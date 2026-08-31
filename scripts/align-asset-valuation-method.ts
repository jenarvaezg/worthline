/**
 * One-off sweep (#1680): align `assets.valuation_method` with the method the
 * holding's INSTRUMENT derives, across every workspace.
 *
 * The column is a leftover of the v13 backfill that nothing decides with any more
 * — the method comes from `valuationMethodOfAsset(instrument)` (ADR 0014), and the
 * three seams that still read the column (the balance-reconciliation guard, the
 * document export, the document import) were moved onto that derivation. What the
 * column still holds is stale: the audit that opened this ticket found a
 * «Colección Numista» — a connected coin collection, `derived` by ADR 0016 —
 * carrying `stored`, which walked straight through the guard.
 *
 * Mechanic: open the control plane, list every workspace, open each workspace DB
 * with a plain libSQL client, read `(id, name, type, is_primary_residence,
 * instrument, valuation_method)`, and UPDATE only the rows whose stored method
 * differs from the derived one. It writes ONE column and nothing else: this value
 * enters no valuation, so there is no curve to re-ripple and no snapshot to
 * rebuild. Idempotent — a second run reports zero rows.
 *
 * Usage — DRY-RUN is the default; NOTHING is written without --apply. Run via the
 * package script, which points tsx at the alias tsconfig so the @db/@domain source
 * graph resolves.
 *
 *   bun run align:valuation-method               # report the drift
 *   bun run align:valuation-method -- --apply    # write the aligned column
 *
 * with WORTHLINE_CONTROL_PLANE_DB_URL + WORTHLINE_DB_AUTH_TOKEN in the environment
 * (e.g. `env $(grep -v '^#' apps/web/.env.local | xargs) bun run align:valuation-method`).
 */
import {
  type ControlPlaneStore,
  type ControlPlaneWorkspace,
  createControlPlaneStore,
  openLibsqlClient,
} from "@worthline/db";
import type { AssetType, Instrument } from "@worthline/domain";
import { valuationMethodOfAsset } from "@worthline/domain";

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

/** Report the drifting rows of one workspace, writing them when --apply is set. */
async function sweepWorkspace(workspace: ControlPlaneWorkspace): Promise<number> {
  const client = openLibsqlClient({ authToken: authToken!, url: workspace.dbUrl });
  try {
    const rows = (
      await client.execute(
        "SELECT id, name, type, is_primary_residence, instrument, valuation_method FROM assets",
      )
    ).rows as unknown as AssetRow[];

    let drifted = 0;
    for (const row of rows) {
      const derived = valuationMethodOfAsset({
        instrument: row.instrument,
        isPrimaryResidence: row.is_primary_residence === 1,
        type: row.type,
      });
      if (row.valuation_method === derived) continue;
      drifted += 1;
      console.log(
        `  ${row.name} (${row.instrument ?? `type:${row.type}`}): ` +
          `${row.valuation_method ?? "NULL"} → ${derived}`,
      );
      if (apply) {
        await client.execute({
          args: [derived, row.id],
          sql: "UPDATE assets SET valuation_method = ? WHERE id = ?",
        });
      }
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
    for (const workspace of workspaces) {
      console.log(`· ${workspace.id}`);
      try {
        total += await sweepWorkspace(workspace);
      } catch (error) {
        console.warn(
          `  ! cannot open DB (${(error as Error).message}) — skipped, NOT swept.`,
        );
      }
    }

    console.log(
      `\n${total} row(s) ${apply ? "aligned" : "would be aligned"}. ` +
        (total === 0 ? "The column is coherent everywhere." : ""),
    );
    if (!apply && total > 0) console.log("Re-run with --apply to write.");
  } finally {
    controlPlane.close();
  }
}

await main();
