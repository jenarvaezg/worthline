import { createRequire } from "node:module";

import type { Database as DatabaseConnection } from "better-sqlite3";

/**
 * Lazy loaders for the native SQLite stack.
 *
 * better-sqlite3 is a native (.node) addon, and `drizzle-orm/better-sqlite3`
 * imports it at module load. If this package imported either at the top level,
 * EVERY importer would load the native binary just by importing — which crashes
 * serverless builds: Next imports each route module during page-data collection,
 * and the native `dlopen` fails in the build sandbox (e.g. Vercel), killing the
 * build worker with no error. These helpers defer the load to when a store is
 * actually opened — at runtime, in the Node lambda, where it loads fine (ADR 0029).
 * Each is memoized after the first load.
 */
const nativeRequire = createRequire(import.meta.url);

type DatabaseCtor = new (filename: string) => DatabaseConnection;

let cachedDatabaseCtor: DatabaseCtor | null = null;

/** The better-sqlite3 `Database` constructor, loaded on first use. */
export function loadDatabaseCtor(): DatabaseCtor {
  cachedDatabaseCtor ??= nativeRequire("better-sqlite3") as DatabaseCtor;
  return cachedDatabaseCtor;
}

/** Bind drizzle to an open connection, loading the adapter (and better-sqlite3) on first use. */
export function openDrizzle(sqlite: DatabaseConnection) {
  const adapter = nativeRequire(
    "drizzle-orm/better-sqlite3",
  ) as typeof import("drizzle-orm/better-sqlite3");
  return adapter.drizzle(sqlite);
}
