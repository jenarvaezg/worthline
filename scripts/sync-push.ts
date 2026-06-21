/**
 * sync:push (S7 #388, ADR 0030) — push the local file workspace up to prod. Backs
 * prod up first, ABORTS if prod changed since the last pull (run `sync:pull`
 * again to reconcile), then full-replaces prod with local — carrying the full
 * snapshot history and re-applying prod's connected-source secrets so the live
 * connection survives. The first push into a fresh prod doubles as the one-time
 * real-data load.
 *
 * Requires WORTHLINE_ENCRYPTION_KEY (to open and re-seal prod's secrets).
 *
 * Usage:
 *   WORTHLINE_SYNC_PROD_URL=libsql://… WORTHLINE_SYNC_PROD_TOKEN=… \
 *   WORTHLINE_ENCRYPTION_KEY=… npm run sync:push
 */
import { SyncStaleError, syncPush } from "@worthline/db";

import { fileSyncDeps, openLocalStore, openProdStore } from "./sync-shared";

async function main(): Promise<void> {
  const prod = await openProdStore();
  const local = await openLocalStore();
  try {
    const { backupLabel, sourcesMissingSecret } = await syncPush(
      local,
      prod,
      fileSyncDeps(),
    );
    console.log(`Pushed local → prod. Prod backed up at ${backupLabel}.`);
    if (sourcesMissingSecret.length > 0) {
      console.warn(
        `Re-enter the API key in prod for: ${sourcesMissingSecret.join(", ")}.`,
      );
    }
  } catch (error: unknown) {
    if (error instanceof SyncStaleError) {
      console.error(`Aborted — ${error.message} Run \`npm run sync:pull\` first.`);
      process.exitCode = 1;
      return;
    }
    throw error;
  } finally {
    prod.close();
    local.close();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
