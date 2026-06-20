import { createRequire } from "node:module";

import type { Client } from "@libsql/client";

/**
 * Lazy loaders for the libSQL stack.
 *
 * `@libsql/client` pulls in a native addon (the `libsql` package) for local
 * `file:`/`:memory:` databases, and `drizzle-orm/libsql` imports the client.
 * If this package loaded either at the top level, EVERY importer would load the
 * native binary just by importing — which crashes serverless builds: Next imports
 * each route module during page-data collection, and the native `dlopen` fails in
 * the build sandbox (e.g. Vercel), killing the build worker with no error. These
 * helpers defer the load to when a store is actually opened — at runtime, in the
 * Node lambda, where it loads fine (ADR 0029/0030). Each is memoized after the
 * first load.
 */
const nativeRequire = createRequire(import.meta.url);

type CreateClient = typeof import("@libsql/client").createClient;

let cachedCreateClient: CreateClient | null = null;

function loadCreateClient(): CreateClient {
  cachedCreateClient ??= (
    nativeRequire("@libsql/client") as typeof import("@libsql/client")
  ).createClient;
  return cachedCreateClient;
}

/**
 * Open a libSQL client for a database path. `:memory:` opens an isolated
 * in-memory database (tests); any other path opens a local file (`file:` URL,
 * local dev). Remote `libsql://` targets arrive in a later slice (#383).
 */
export function openLibsqlClient(databasePath: string): Client {
  const url = databasePath === ":memory:" ? ":memory:" : `file:${databasePath}`;
  return loadCreateClient()({ url });
}

/** Bind drizzle to an open libSQL client, loading the adapter on first use. */
export function openDrizzle(client: Client) {
  const adapter = nativeRequire(
    "drizzle-orm/libsql",
  ) as typeof import("drizzle-orm/libsql");
  return adapter.drizzle(client);
}
