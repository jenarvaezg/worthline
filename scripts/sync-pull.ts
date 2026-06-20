/**
 * sync:pull (S7 #388, ADR 0030) — pull the prod workspace into the local file
 * database. Exports prod and imports it into local, carrying the full frozen
 * snapshot history (ADR 0010/0012/0015), and records the prod fingerprint as the
 * staleness baseline for the next push.
 *
 * Usage:
 *   WORTHLINE_SYNC_PROD_URL=libsql://… WORTHLINE_SYNC_PROD_TOKEN=… \
 *     npm run sync:pull
 */
import { syncPull } from "@worthline/db";

import { fileSyncDeps, openLocalStore, openProdStore } from "./sync-shared";

async function main(): Promise<void> {
  const prod = await openProdStore();
  const local = await openLocalStore();
  try {
    const { fingerprint } = await syncPull(prod, local, fileSyncDeps());
    console.log(`Pulled prod → local. Baseline fingerprint ${fingerprint.slice(0, 12)}…`);
  } finally {
    prod.close();
    local.close();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
