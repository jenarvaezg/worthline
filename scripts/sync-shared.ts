/**
 * Shared wiring for the local↔prod sync commands (S7 #388, ADR 0030). Opens the
 * prod (Turso) and local (file) workspace stores and builds a file-backed
 * {@link SyncDeps} — the last-pull fingerprint and prod backups live next to the
 * local database, under a `sync/` directory.
 *
 * Env:
 *   WORTHLINE_SYNC_PROD_URL    the prod workspace libsql:// URL (required)
 *   WORTHLINE_SYNC_PROD_TOKEN  the Turso auth token for that URL
 *   WORTHLINE_DB_PATH          the local database file (defaults to the data dir)
 *   WORTHLINE_ENCRYPTION_KEY   required by push to open + re-seal prod's secrets
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import {
  createWorthlineStore,
  resolveDatabasePath,
  type SyncDeps,
  type WorthlineStore,
} from "@worthline/db";
import type { WorkspaceExport } from "@worthline/domain";

/** Open the prod workspace store from the sync env (libsql:// + token). */
export function openProdStore(): Promise<WorthlineStore> {
  const url = process.env.WORTHLINE_SYNC_PROD_URL;
  if (!url) {
    throw new Error(
      "WORTHLINE_SYNC_PROD_URL must be set (the prod workspace libsql:// URL).",
    );
  }
  return createWorthlineStore({ url, authToken: process.env.WORTHLINE_SYNC_PROD_TOKEN });
}

/** Open the local workspace store (the developer's file database). */
export function openLocalStore(): Promise<WorthlineStore> {
  return createWorthlineStore({ databasePath: resolveDatabasePath() });
}

/** The `sync/` directory next to the local database (created on demand). */
function syncDir(): string {
  const dir = join(dirname(resolveDatabasePath()), "sync");
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** A {@link SyncDeps} backed by JSON files under the local `sync/` directory. */
export function fileSyncDeps(): SyncDeps {
  const dir = syncDir();
  const statePath = join(dir, "state.json");
  return {
    readLastPull() {
      try {
        const state = JSON.parse(readFileSync(statePath, "utf8")) as {
          lastPull?: string;
        };
        return state.lastPull ?? null;
      } catch {
        return null; // never pulled (no state file yet)
      }
    },
    writeLastPull(fingerprint) {
      writeFileSync(statePath, `${JSON.stringify({ lastPull: fingerprint }, null, 2)}\n`);
    },
    backup(doc: WorkspaceExport, label: string) {
      const safeLabel = label.replace(/[:.]/g, "-");
      const path = join(dir, `prod-backup-${safeLabel}.json`);
      writeFileSync(path, `${JSON.stringify(doc, null, 2)}\n`);
    },
    now() {
      return new Date().toISOString();
    },
  };
}
