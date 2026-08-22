/**
 * One-off fix (#1437): the piso de Plasencia was entered with the date it was
 * typed (2026-07-02) instead of the real purchase (2004-05-19), which amputated
 * the household's history from that date onward.
 *
 * It edits the acquisition anchor through `store.command.updateValuationAnchor`
 * — never raw SQL — so the value curve and the historical snapshots ripple
 * behind the same seam the UI uses. Opening the store also runs migrations, so
 * the anchor is already marked `kind = 'acquisition'` by the time we look.
 *
 * DRY-RUN BY DEFAULT: it prints what it would change and touches nothing.
 * Pass --apply to write.
 *
 * Usage:
 *   npx tsx scripts/fix-piso-plasencia.ts            # dry-run
 *   npx tsx scripts/fix-piso-plasencia.ts --apply    # write
 *   WORTHLINE_DB_URL=libsql://… npx tsx scripts/fix-piso-plasencia.ts --apply
 */
import { withStoreUnsafe } from "@worthline/db/unsafe-store";

const APPLY = process.argv.includes("--apply");

const ASSET_NAME_PATTERN = /plasencia/i;
const NEW_ACQUISITION = {
  /** 19 de mayo de 2004, escrito en el Excel de Papá. */
  valuationDate: "2004-05-19",
  /** 150.253,03 € en unidades menores. */
  valueMinor: 15_025_303,
};

const eur = (minor: number) =>
  (minor / 100).toLocaleString("es-ES", { minimumFractionDigits: 2 }) + " €";

await withStoreUnsafe(async (store) => {
  const asset = (await store.assets.readAssets()).find(
    (a) => a.type === "real_estate" && ASSET_NAME_PATTERN.test(a.name),
  );
  if (!asset) {
    console.error(`No real_estate asset matching ${ASSET_NAME_PATTERN} found.`);
    process.exitCode = 1;
    return;
  }
  console.log(`Asset: ${asset.name} (${asset.id})`);

  const anchors = await store.assets.readValuationAnchors(asset.id);
  const acquisition =
    anchors.find((a) => a.kind === "acquisition") ??
    anchors
      .filter((a) => a.adjustsPriorCurve)
      .sort((a, b) => a.valuationDate.localeCompare(b.valuationDate))[0];
  if (!acquisition) {
    console.error("The asset has no market-appraisal anchor to act as acquisition.");
    process.exitCode = 1;
    return;
  }

  console.log(
    `Acquisition anchor ${acquisition.id}: ${acquisition.valuationDate} · ${eur(acquisition.valueMinor)}`,
  );
  console.log(
    `  -> would become:        ${NEW_ACQUISITION.valuationDate} · ${eur(NEW_ACQUISITION.valueMinor)}`,
  );

  if (
    acquisition.valuationDate === NEW_ACQUISITION.valuationDate &&
    acquisition.valueMinor === NEW_ACQUISITION.valueMinor
  ) {
    console.log("Already correct — nothing to do.");
    return;
  }

  if (!APPLY) {
    console.log("\nDry-run only. Re-run with --apply to write.");
    return;
  }

  const result = await store.command.updateValuationAnchor(
    acquisition.id,
    { ...NEW_ACQUISITION },
    { today: new Date().toISOString().slice(0, 10) },
  );
  if (result.changes === 0) {
    console.error("The update touched nothing — aborting.");
    process.exitCode = 1;
    return;
  }

  const after = await store.assets.readValuationAnchors(asset.id);
  const fixed = after.find((a) => a.id === acquisition.id);
  console.log(
    `\nApplied. Anchor now reads ${fixed?.valuationDate} · ${eur(fixed?.valueMinor ?? 0)}.`,
  );
  console.log(
    `Snapshots now reach back to ${
      (await store.snapshots.readSnapshots()).map((s) => s.dateKey).sort()[0]
    }.`,
  );
});
