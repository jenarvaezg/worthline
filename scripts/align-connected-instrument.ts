/**
 * One-off sweep (#1691): align a connected holding's `assets.instrument` with the
 * instrument its ADAPTER dictates, across every workspace.
 *
 * A source's holding is `coin_collection` (Numista) or `crypto` (Binance) by
 * construction — `instrumentForAdapter`, ADR 0016/0021. The v14 backfill derived
 * the column from the legacy `AssetType` with a blind `ELSE 'other'` and never
 * looked at `connected_source_id`, and `connect` materializes the holding as
 * `type = 'manual'` — so every collection connected before that migration came out
 * of it labelled `other`.
 *
 * The value stayed right (the sync matches the row by source + rung, never by
 * instrument), which is why it went unnoticed. What went wrong is everything the
 * instrument decides: the ficha's family, the hero's change attribution, the
 * exposure class, a `STALE_MANUAL_VALUE` notice whose fix excludes the holding, and
 * an instrument picker offering to relabel the one holding nobody may relabel.
 *
 * The sync now re-asserts the instrument on every re-roll, so these rows heal
 * themselves at their next sync. This script is the impatient version: it fixes
 * them now, without waiting for one.
 *
 * Mechanic: open the control plane, list every workspace, join `assets` to
 * `connected_sources` on the asset's own back-link, and UPDATE only the rows whose
 * instrument differs from their adapter's. One column, nothing else: no figure is
 * derived from it on these rows (the live value comes from the positions sum, the
 * historical one routes by source), so there is no curve to re-ripple.
 * Idempotent — a second run reports zero rows.
 *
 * Usage — DRY-RUN is the default; NOTHING is written without --apply.
 *
 *   bun run align:connected-instrument               # report the drift
 *   bun run align:connected-instrument -- --apply    # write the instrument
 *
 * with WORTHLINE_CONTROL_PLANE_DB_URL + WORTHLINE_DB_AUTH_TOKEN in the environment.
 */
import {
  type ControlPlaneStore,
  type ControlPlaneWorkspace,
  createControlPlaneStore,
  openLibsqlClient,
} from "@worthline/db";
import type { Instrument, SourceAdapter } from "@worthline/domain";
import { instrumentForAdapter } from "@worthline/domain";

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

interface ConnectedRow {
  id: string;
  name: string;
  instrument: Instrument | null;
  adapter: SourceAdapter;
  deleted_at: string | null;
}

/** Report the mislabelled connected rows of one workspace; write them with --apply. */
async function sweepWorkspace(workspace: ControlPlaneWorkspace): Promise<number> {
  const client = openLibsqlClient({ authToken: authToken!, url: workspace.dbUrl });
  try {
    const rows = (
      await client.execute(
        `SELECT a.id, a.name, a.instrument, a.deleted_at, s.adapter
           FROM assets a
           JOIN connected_sources s ON s.id = a.connected_source_id`,
      )
    ).rows as unknown as ConnectedRow[];

    let drifted = 0;
    for (const row of rows) {
      // A TRASHED rung asset is left alone: a disconnect deliberately freezes its
      // instrument to the hand-valued counterpart (`frozenInstrumentForAdapter`),
      // and re-asserting the live one would undo that.
      if (row.deleted_at !== null) continue;

      const derived = instrumentForAdapter(row.adapter);
      if (row.instrument === derived) continue;
      drifted += 1;
      console.log(
        `  ${row.name} (${row.adapter}): ${row.instrument ?? "NULL"} → ${derived}`,
      );
      if (apply) {
        await client.execute({
          args: [derived, row.id],
          sql: "UPDATE assets SET instrument = ? WHERE id = ?",
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
        (total === 0
          ? " — every connected holding wears its adapter's instrument."
          : "."),
    );
    if (!apply && total > 0) console.log("Re-run with --apply to write.");
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
