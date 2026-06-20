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

export interface LibsqlUrlTarget {
  url: string;
  authToken?: string;
}

let cachedCreateClient: CreateClient | null = null;

function loadCreateClient(): CreateClient {
  cachedCreateClient ??= (
    nativeRequire("@libsql/client") as typeof import("@libsql/client")
  ).createClient;
  return cachedCreateClient;
}

/**
 * Open a libSQL client for a database path or URL target. `:memory:` opens an
 * isolated in-memory database (tests); a string path opens a local file
 * (`file:` URL, local dev); a URL target opens any libSQL-compatible URL
 * (`file:`, `libsql://`, etc.).
 */
export function openLibsqlClient(databasePathOrTarget: string | LibsqlUrlTarget): Client {
  if (typeof databasePathOrTarget !== "string") {
    return loadCreateClient()({
      url: databasePathOrTarget.url,
      ...(databasePathOrTarget.authToken
        ? { authToken: databasePathOrTarget.authToken }
        : {}),
    });
  }

  const url =
    databasePathOrTarget === ":memory:" ? ":memory:" : `file:${databasePathOrTarget}`;
  return loadCreateClient()({ url });
}

/** Bind drizzle to an open libSQL client, loading the adapter on first use. */
export function openDrizzle(client: Client) {
  const adapter = nativeRequire(
    "drizzle-orm/libsql",
  ) as typeof import("drizzle-orm/libsql");
  return adapter.drizzle(client);
}
