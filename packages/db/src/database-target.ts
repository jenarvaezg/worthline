import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { Client } from "@libsql/client";
import type { LocalPersistenceStatus } from "@worthline/domain";
import { eq } from "drizzle-orm";

import { openDrizzle, openLibsqlClient } from "./libsql-client";
import { migrate, SCHEMA_VERSION } from "./migrate";
import { appSettings } from "./schema";
import type {
  BootstrapHealthcheckOptions,
  DatabaseTarget,
  DatabaseTargetEnv,
} from "./store-types";

const bootstrapKey = "bootstrap.last_healthcheck_at";

/**
 * Per-process memo of remote databases already confirmed at the compiled schema
 * version (perf #445 / #1194). The ladder is idempotent and the schema only ever
 * changes on a deploy, so re-reading `schema_meta` on every request to a warm
 * lambda is pure network round-trip overhead — the whole `migrate()` call is
 * skipped once a base is known to be at-version.
 *
 * The key is `${url}@${SCHEMA_VERSION}`, i.e. the base URL qualified by the
 * COMPILED schema version. A deploy that ships a new schema also ships a new
 * `SCHEMA_VERSION` constant, so its warm processes compute a different key and can
 * never hit a stale "already migrated" entry — the memo is invalidated by
 * construction, independent of process lifetime (a fresh lambda starts empty too;
 * the version qualifier just makes the guarantee explicit rather than incidental).
 *
 * Never memoized for `path` targets (`:memory:` / `file:` opened by path): those
 * reuse a single string across genuinely distinct databases (every
 * `createInMemoryStore()` is a fresh DB), so skipping their migration would be a
 * correctness bug. Remote URLs are unique per workspace and stable, so keying the
 * skip on the URL is safe — and each workspace gets its own entry, so a
 * multi-tenant process (admin/impersonation, demo) never contaminates one base's
 * state with another's.
 */
const migratedTargets = new Set<string>();

/** The versioned memo key for a remote base — see {@link migratedTargets}. */
function migratedTargetKey(url: string): string {
  return `${url}@${SCHEMA_VERSION}`;
}

export async function migrateTarget(target: DatabaseTarget, client: Client) {
  const key = target.kind === "url" ? migratedTargetKey(target.url) : null;
  if (key !== null && migratedTargets.has(key)) {
    return { ranV18Backfill: false, ranV33Backfill: false };
  }
  const result = await migrate(client);
  // Populate ONLY after `migrate()` has verified/reached the target version: a
  // base that still needed migrating is memoized exactly once its ladder ran, and
  // a thrown migration never records a false "at-version".
  if (key !== null) migratedTargets.add(key);
  return result;
}

/**
 * Test-only: clear the per-process migration memo so a spec observes a cold first
 * open. Never called by production paths (the memo is meant to persist for the
 * life of the process).
 */
export function __resetMigratedTargetsForTests(): void {
  migratedTargets.clear();
}

export async function runBootstrapHealthcheck(
  options: BootstrapHealthcheckOptions = {},
): Promise<LocalPersistenceStatus> {
  const target = resolveDatabaseTarget(options);
  const client = openDatabaseTarget(target);
  try {
    await migrateTarget(target, client);

    const db = openDrizzle(client);
    const checkedAt = (options.now ?? (() => new Date()))().toISOString();

    await db
      .insert(appSettings)
      .values({
        key: bootstrapKey,
        updatedAt: checkedAt,
        value: checkedAt,
      })
      .onConflictDoUpdate({
        target: appSettings.key,
        set: {
          updatedAt: checkedAt,
          value: checkedAt,
        },
      })
      .run();

    const row = await db
      .select()
      .from(appSettings)
      .where(eq(appSettings.key, bootstrapKey))
      .get();

    if (!row) {
      throw new Error("Database bootstrap check did not persist an app setting.");
    }

    return {
      status: "ok",
      checkKey: bootstrapKey,
      checkedAt,
      checkValue: row.value,
      databasePath: target.kind === "path" ? target.databasePath : target.url,
      displayPath:
        target.kind === "path" ? toDisplayPath(target.databasePath) : target.url,
    };
  } finally {
    client.close();
  }
}

export function openDatabaseTarget(target: DatabaseTarget): Client {
  if (target.kind === "path") {
    mkdirSync(dirname(target.databasePath), { recursive: true });
    return openLibsqlClient(target.databasePath);
  }

  return openLibsqlClient(target);
}

export function resolveDatabasePath(options: BootstrapHealthcheckOptions = {}): string {
  if (options.databasePath) {
    return resolve(options.databasePath);
  }

  if (process.env.WORTHLINE_DB_PATH) {
    return resolve(process.env.WORTHLINE_DB_PATH);
  }

  return join(resolveDataDir(options), "worthline.sqlite");
}

export function resolveDatabaseTarget(
  options: BootstrapHealthcheckOptions = {},
  env: DatabaseTargetEnv = process.env,
): DatabaseTarget {
  if (options.databasePath) {
    return { kind: "path", databasePath: resolveDatabasePath(options) };
  }

  if (options.url) {
    if (options.url.startsWith("libsql://") && !options.authToken) {
      throw new Error("authToken is required when opening a libsql:// URL directly.");
    }
    return {
      kind: "url",
      url: options.url,
      ...(options.authToken ? { authToken: options.authToken } : {}),
    };
  }

  if (env.WORTHLINE_DB_PATH) {
    return { kind: "path", databasePath: resolve(env.WORTHLINE_DB_PATH) };
  }

  if (!env.WORTHLINE_DB_URL) {
    return { kind: "path", databasePath: resolveDatabasePath(options) };
  }

  if (env.WORTHLINE_DB_URL.startsWith("libsql://") && !env.WORTHLINE_DB_AUTH_TOKEN) {
    throw new Error(
      "WORTHLINE_DB_AUTH_TOKEN is required when WORTHLINE_DB_URL is a libsql:// URL.",
    );
  }

  return {
    kind: "url",
    url: env.WORTHLINE_DB_URL,
    ...(env.WORTHLINE_DB_AUTH_TOKEN ? { authToken: env.WORTHLINE_DB_AUTH_TOKEN } : {}),
  };
}

export function resolveDataDir(options: BootstrapHealthcheckOptions = {}): string {
  if (options.dataDir) {
    return resolve(options.dataDir);
  }

  if (process.env.WORTHLINE_DATA_DIR) {
    return resolve(process.env.WORTHLINE_DATA_DIR);
  }

  return join(findWorkspaceRoot(), ".local", "worthline");
}

function toDisplayPath(databasePath: string): string {
  const workspaceRoot = findWorkspaceRoot();
  const relativePath = relative(workspaceRoot, databasePath);

  if (relativePath && !relativePath.startsWith("..") && !isAbsolute(relativePath)) {
    return relativePath;
  }

  return databasePath;
}

function findWorkspaceRoot(startAt = process.cwd()): string {
  let current = resolve(startAt);

  while (true) {
    const manifestPath = join(current, "package.json");

    if (existsSync(manifestPath)) {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
        workspaces?: unknown;
      };

      if (manifest.workspaces) {
        return current;
      }
    }

    const parent = dirname(current);

    if (parent === current) {
      return resolve(startAt);
    }

    current = parent;
  }
}
