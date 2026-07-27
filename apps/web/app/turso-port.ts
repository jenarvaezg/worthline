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
    async createDatabaseToken(name) {
      const { createClient } = await import("@tursodatabase/api");
      const client = createClient({ org: config.org, token: config.token });
      // No expiration: the JWT is stored on the control-plane workspace row and
      // reused like the old group token was — rotated by operators via the
      // backfill / Platform API when needed (#1185).
      const token = await client.databases.createToken(name, {
        authorization: "full-access",
      });
      return { jwt: token.jwt };
    },
    async deleteDatabase(name) {
      const { createClient } = await import("@tursodatabase/api");
      const client = createClient({ org: config.org, token: config.token });
      await client.databases.delete(name);
    },
  };
}
