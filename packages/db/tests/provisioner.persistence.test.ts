import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInMemoryControlPlaneStore } from "@db/control-plane";
import { openLibsqlClient } from "@db/libsql-client";
import { SCHEMA_VERSION } from "@db/migrate";
import { provisionWorkspaceForUser, type TursoPort } from "@db/provisioner";
import { afterAll, describe, expect, test } from "vitest";

const tempDirs: string[] = [];
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { force: true, recursive: true });
});

/**
 * A fake Turso Platform port: "creating a database" hands back a local `file:`
 * URL in a temp dir, so the provisioner runs the real migration against a real
 * libSQL database — no network, no Turso account.
 */
function fakeTurso(dir: string): { port: TursoPort; created: string[] } {
  const created: string[] = [];
  return {
    created,
    port: {
      async createDatabase(name) {
        created.push(name);
        return { name, url: `file:${join(dir, `${name}.sqlite`)}` };
      },
    },
  };
}

describe("workspace provisioner", () => {
  test("provisions a fresh workspace: creates a db, migrates it, writes workspace + grant", async () => {
    const cp = await createInMemoryControlPlaneStore();
    const { port, created } = fakeTurso(tempDir("worthline-provision-"));
    try {
      const ws = await provisionWorkspaceForUser(
        { controlPlane: cp, turso: port },
        "ana@example.com",
      );

      // 1. A database was created via the Turso port.
      expect(created).toHaveLength(1);
      expect(ws.dbName).toBe(created[0]);

      // 2. workspace + grant rows were written in the control plane.
      const user = await cp.findOrCreateUser("ana@example.com");
      expect(await cp.readGrant(user.id, ws.id)).not.toBeNull();

      // 3. The new workspace database was migrated to the current schema.
      //    Open a RAW client (not createWorthlineStore, which would migrate it
      //    itself) so this asserts the provisioner did the migration.
      const raw = openLibsqlClient({ url: ws.dbUrl });
      const version = Number(
        (await raw.execute("PRAGMA user_version")).rows[0]!["user_version"],
      );
      raw.close();
      expect(version).toBe(SCHEMA_VERSION);
    } finally {
      cp.close();
    }
  });

  test("is idempotent: a second login for the same account reuses the workspace, no new db", async () => {
    const cp = await createInMemoryControlPlaneStore();
    const { port, created } = fakeTurso(tempDir("worthline-provision-idem-"));
    try {
      const first = await provisionWorkspaceForUser(
        { controlPlane: cp, turso: port },
        "ana@example.com",
      );
      const second = await provisionWorkspaceForUser(
        { controlPlane: cp, turso: port },
        "ana@example.com",
      );

      expect(second.id).toBe(first.id);
      expect(created).toHaveLength(1);
    } finally {
      cp.close();
    }
  });

  test("two different accounts get two different, isolated workspaces", async () => {
    const cp = await createInMemoryControlPlaneStore();
    const { port, created } = fakeTurso(tempDir("worthline-provision-iso-"));
    try {
      const ana = await provisionWorkspaceForUser(
        { controlPlane: cp, turso: port },
        "ana@example.com",
      );
      const leo = await provisionWorkspaceForUser(
        { controlPlane: cp, turso: port },
        "leo@example.com",
      );

      expect(leo.id).not.toBe(ana.id);
      expect(leo.dbName).not.toBe(ana.dbName);
      expect(leo.dbUrl).not.toBe(ana.dbUrl);
      expect(created).toHaveLength(2);
    } finally {
      cp.close();
    }
  });
});
