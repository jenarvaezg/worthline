import type { TursoPort } from "@worthline/db";

/**
 * Real Turso Platform API adapter for the provisioner's injected port (ADR 0030).
 * Lazy-imports `@tursodatabase/api` so the SDK only loads in the Node runtime
 * when a workspace is actually being provisioned — never in the edge proxy,
 * the local no-auth build, or tests (which inject a fake port instead).
 */

export interface TursoPortConfig {
  /** Organization slug. */
  org: string;
  /** Turso Platform API token. */
  token: string;
  /** Database group the new database is created in (defaults to Turso's default). */
  group?: string;
}

export function createTursoPort(config: TursoPortConfig): TursoPort {
  return {
    async createDatabase(name) {
      const { createClient } = await import("@tursodatabase/api");
      const client = createClient({ org: config.org, token: config.token });
      const db = await client.databases.create(
        name,
        config.group ? { group: config.group } : {},
      );
      return { name: db.name, url: `libsql://${db.hostname}` };
    },
    async createDatabaseToken(name, authorization) {
      const { createClient } = await import("@tursodatabase/api");
      const client = createClient({ org: config.org, token: config.token });
      // No expiration: the JWT is stored on the control-plane workspace row and
      // reused like the old group token was — rotated by operators via the
      // backfill / Platform API when needed (#1185). `read-only` is the
      // viewer's credential (#1841); provisioning always asks `full-access`.
      const token = await client.databases.createToken(name, { authorization });
      return { jwt: token.jwt };
    },
    async deleteDatabase(name) {
      const { createClient } = await import("@tursodatabase/api");
      const client = createClient({ org: config.org, token: config.token });
      await client.databases.delete(name);
    },
  };
}

/**
 * The real port from env, for the two hosted surfaces that reach Turso's Platform
 * API: provisioning on first sign-in, and the owner's first share minting the
 * workspace's read-only token (#1844). Throws naming what is missing.
 */
export function tursoPortFromEnv(env: Record<string, string | undefined>): TursoPort {
  const tursoOrg = env["TURSO_ORG"];
  const tursoToken = env["TURSO_API_TOKEN"];
  if (!env["WORTHLINE_CONTROL_PLANE_DB_URL"] || !tursoOrg || !tursoToken) {
    throw new Error(
      "Reaching Turso's Platform API (provisioning a workspace, or minting its read-only token to share it) requires WORTHLINE_CONTROL_PLANE_DB_URL, TURSO_ORG, and TURSO_API_TOKEN.",
    );
  }
  return createTursoPort({
    org: tursoOrg,
    token: tursoToken,
    ...(env["TURSO_GROUP"] ? { group: env["TURSO_GROUP"] } : {}),
  });
}
