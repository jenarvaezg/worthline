/**
 * The viewer role in the tenancy port (#1841, S1 of #1718, ADR 0112). A grant is
 * `owner` or `viewer`; any other stored value grants nothing. Resolution only
 * ever returns owned workspaces, and the viewer reads are separate methods that
 * never return the full token.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AdminControlPlaneStore,
  createControlPlaneStore,
  createInMemoryControlPlaneStore,
} from "@db/control-plane";
import {
  CP_SCHEMA_VERSION,
  migrateControlPlane,
  readControlPlaneSchemaVersion,
  writeControlPlaneSchemaVersion,
} from "@db/control-plane/migrate";
import { createTenancyDirectory } from "@db/control-plane/tenancy-directory";
import { openLibsqlClient } from "@db/libsql-client";
import { afterAll, afterEach, describe, expect, test } from "vitest";
import { instrumentClient } from "./instrument-libsql-client";

const tempDirs: string[] = [];
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { force: true, recursive: true });
});

/** Ana owns `wl-ana`; Leo owns `wl-leo`. */
async function twoOwners(cp: AdminControlPlaneStore) {
  const ana = await cp.findOrCreateUser("ana@example.com");
  const leo = await cp.findOrCreateUser("leo@example.com");
  const anaWs = await cp.createWorkspace({
    dbAuthToken: "full-ana",
    dbName: "wl-ana",
    dbUrl: "libsql://wl-ana.turso.io",
  });
  const leoWs = await cp.createWorkspace({
    dbAuthToken: "full-leo",
    dbName: "wl-leo",
    dbUrl: "libsql://wl-leo.turso.io",
  });
  await cp.recordGrant(ana.id, anaWs.id);
  await cp.recordGrant(leo.id, leoWs.id);
  return { ana, anaWs, leo, leoWs };
}

describe("control-plane read-only token migration (#1841)", () => {
  test("a v10 control plane gains the nullable read-only token column", async () => {
    const dir = mkdtempSync(join(tmpdir(), "worthline-cp-v11-"));
    tempDirs.push(dir);
    const url = `file:${join(dir, "control-plane.sqlite")}`;
    const raw = openLibsqlClient({ url });
    await raw.executeMultiple(`
      CREATE TABLE workspaces (
        id TEXT PRIMARY KEY,
        db_name TEXT NOT NULL UNIQUE,
        db_url TEXT NOT NULL,
        db_auth_token TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      INSERT INTO workspaces (id, db_name, db_url, db_auth_token)
        VALUES ('w1', 'wl-a', 'libsql://wl-a.turso.io', 'full-a');
    `);
    await writeControlPlaneSchemaVersion(raw, 10);

    await migrateControlPlane(raw);

    expect(await readControlPlaneSchemaVersion(raw)).toBe(CP_SCHEMA_VERSION);
    expect(CP_SCHEMA_VERSION).toBeGreaterThanOrEqual(11);
    const row = await raw.execute("SELECT db_read_only_token FROM workspaces");
    expect(row.rows[0]?.["db_read_only_token"]).toBeNull();
    raw.close();

    const cp = await createControlPlaneStore({ url });
    try {
      expect((await cp.listAllWorkspaces())[0]).toMatchObject({
        dbAuthToken: "full-a",
        hasReadOnlyToken: false,
      });
    } finally {
      cp.close();
    }
  });
});

describe("tenancy · owned resolution (#1841)", () => {
  test("an owner with a viewer grant elsewhere resolves only to their own workspace", async () => {
    const cp = await createInMemoryControlPlaneStore();
    try {
      const { ana, anaWs, leoWs } = await twoOwners(cp);
      await cp.recordGrant(ana.id, leoWs.id, "viewer");

      const owned = await cp.listOwnedWorkspacesForUser(ana.id);
      expect(owned.map((workspace) => workspace.id)).toEqual([anaWs.id]);
    } finally {
      cp.close();
    }
  });

  test("an identity with only a viewer grant owns nothing", async () => {
    const cp = await createInMemoryControlPlaneStore();
    try {
      const { leoWs } = await twoOwners(cp);
      const eva = await cp.findOrCreateUser("eva@example.com");
      await cp.recordGrant(eva.id, leoWs.id, "viewer");

      expect(await cp.listOwnedWorkspacesForUser(eva.id)).toEqual([]);
    } finally {
      cp.close();
    }
  });

  test("a row with an unknown role appears in no listing and reads as no grant", async () => {
    const dir = mkdtempSync(join(tmpdir(), "worthline-cp-unknown-role-"));
    tempDirs.push(dir);
    const url = `file:${join(dir, "control-plane.sqlite")}`;
    const cp = await createControlPlaneStore({ url });
    const { ana, leo, leoWs } = await twoOwners(cp as AdminControlPlaneStore);
    const eva = await cp.findOrCreateUser("eva@example.com");
    await cp.setWorkspaceReadOnlyToken(leoWs.id, "ro-leo");
    cp.close();

    // Written behind the port's back: the legacy `orphaned-owner` and a value
    // nobody ever defined. Neither is `owner` nor `viewer`.
    const raw = openLibsqlClient({ url });
    await raw.execute({
      sql: "INSERT INTO grants (user_id, workspace_id, role) VALUES (?, ?, 'orphaned-owner'), (?, ?, 'admin')",
      args: [ana.id, leoWs.id, eva.id, leoWs.id],
    });
    raw.close();

    const reopened = await createControlPlaneStore({ url });
    try {
      expect(await reopened.readGrant(ana.id, leoWs.id)).toBeNull();
      expect(await reopened.readGrant(eva.id, leoWs.id)).toBeNull();
      expect(await reopened.listOwnedWorkspacesForUser(eva.id)).toEqual([]);
      expect(
        (await reopened.listOwnedWorkspacesForUser(ana.id)).map((w) => w.id),
      ).not.toContain(leoWs.id);
      expect(await reopened.listViewersOfWorkspace(leoWs.id)).toEqual([]);
      expect(await reopened.listWorkspacesSharedWithUser(ana.id)).toEqual([]);
      expect(await reopened.listWorkspacesSharedWithUser(eva.id)).toEqual([]);
      expect(
        await reopened.readViewerAccess({
          viewerEmail: "eva@example.com",
          workspaceId: leoWs.id,
        }),
      ).toBeNull();
      expect((await reopened.getWorkspaceWithOwner(leoWs.id))?.ownerEmail).toBe(
        leo.email,
      );
    } finally {
      reopened.close();
    }
  });
});

describe("tenancy · owner email ignores viewers (#1841)", () => {
  test("the owner's email survives an older viewer grant", async () => {
    const cp = await createInMemoryControlPlaneStore();
    try {
      const eva = await cp.findOrCreateUser("eva@example.com");
      const leo = await cp.findOrCreateUser("leo@example.com");
      const leoWs = await cp.createWorkspace({
        dbName: "wl-leo",
        dbUrl: "libsql://wl-leo.turso.io",
      });
      // The viewer grant lands FIRST: the old «oldest grant» rule would have
      // named Eva the owner.
      await cp.recordGrant(eva.id, leoWs.id, "viewer");
      await cp.recordGrant(leo.id, leoWs.id);

      expect((await cp.getWorkspaceWithOwner(leoWs.id))?.ownerEmail).toBe(
        "leo@example.com",
      );
      const all = await cp.listWorkspacesWithOwners();
      expect(all.find((w) => w.id === leoWs.id)?.ownerEmail).toBe("leo@example.com");
    } finally {
      cp.close();
    }
  });

  test("a workspace with only viewer grants has no owner email", async () => {
    const cp = await createInMemoryControlPlaneStore();
    try {
      const eva = await cp.findOrCreateUser("eva@example.com");
      const ws = await cp.createWorkspace({
        dbName: "wl-lonely",
        dbUrl: "libsql://wl-lonely.turso.io",
      });
      await cp.recordGrant(eva.id, ws.id, "viewer");

      expect((await cp.getWorkspaceWithOwner(ws.id))?.ownerEmail).toBeNull();
    } finally {
      cp.close();
    }
  });
});

describe("tenancy · viewer reads (#1841)", () => {
  test("lists a workspace's viewers, never its owner", async () => {
    const cp = await createInMemoryControlPlaneStore();
    try {
      const { ana, anaWs, leo } = await twoOwners(cp);
      await cp.recordGrant(leo.id, anaWs.id, "viewer");

      const viewers = await cp.listViewersOfWorkspace(anaWs.id);
      expect(viewers).toEqual([
        { createdAt: expect.any(String), email: "leo@example.com", userId: leo.id },
      ]);
      expect(viewers.map((viewer) => viewer.userId)).not.toContain(ana.id);
    } finally {
      cp.close();
    }
  });

  test("lists the workspaces shared with a user, with each owner's email", async () => {
    const cp = await createInMemoryControlPlaneStore();
    try {
      const { ana, anaWs, leo, leoWs } = await twoOwners(cp);
      await cp.recordGrant(leo.id, anaWs.id, "viewer");

      expect(await cp.listWorkspacesSharedWithUser(leo.id)).toEqual([
        {
          createdAt: expect.any(String),
          ownerEmail: "ana@example.com",
          workspaceId: anaWs.id,
        },
      ]);
      // Ana's own workspace is owned, not shared with her.
      expect(await cp.listWorkspacesSharedWithUser(ana.id)).toEqual([]);
      expect(
        (await cp.listWorkspacesSharedWithUser(leo.id)).map((w) => w.workspaceId),
      ).not.toContain(leoWs.id);
    } finally {
      cp.close();
    }
  });

  test("revoking a viewer removes only that grant", async () => {
    const cp = await createInMemoryControlPlaneStore();
    try {
      const { anaWs, leo } = await twoOwners(cp);
      await cp.recordGrant(leo.id, anaWs.id, "viewer");

      expect(await cp.revokeViewerGrant(anaWs.id, leo.id)).toBe(true);
      expect(await cp.listViewersOfWorkspace(anaWs.id)).toEqual([]);
      expect(await cp.readGrant(leo.id, anaWs.id)).toBeNull();
      expect(await cp.revokeViewerGrant(anaWs.id, leo.id)).toBe(false);
    } finally {
      cp.close();
    }
  });

  test("revoking with the owner's user id never touches the owner grant", async () => {
    const cp = await createInMemoryControlPlaneStore();
    try {
      const { ana, anaWs } = await twoOwners(cp);

      expect(await cp.revokeViewerGrant(anaWs.id, ana.id)).toBe(false);
      expect((await cp.readGrant(ana.id, anaWs.id))?.role).toBe("owner");
      expect((await cp.listOwnedWorkspacesForUser(ana.id)).map((w) => w.id)).toEqual([
        anaWs.id,
      ]);
    } finally {
      cp.close();
    }
  });
});

describe("tenancy · read-only access (#1841)", () => {
  const savedKey = process.env.WORTHLINE_ENCRYPTION_KEY;
  afterEach(() => {
    if (savedKey === undefined) delete process.env.WORTHLINE_ENCRYPTION_KEY;
    else process.env.WORTHLINE_ENCRYPTION_KEY = savedKey;
  });

  test("a viewer of a workspace with a read-only token gets that token, never the full one", async () => {
    const cp = await createInMemoryControlPlaneStore();
    try {
      const { anaWs, leo } = await twoOwners(cp);
      await cp.setWorkspaceReadOnlyToken(anaWs.id, "ro-ana");
      await cp.recordGrant(leo.id, anaWs.id, "viewer");

      const access = await cp.readViewerAccess({
        viewerEmail: "leo@example.com",
        workspaceId: anaWs.id,
      });
      expect(access).toEqual({
        dbUrl: "libsql://wl-ana.turso.io",
        ownerEmail: "ana@example.com",
        readOnlyToken: "ro-ana",
        viewerEmail: "leo@example.com",
        workspaceId: anaWs.id,
      });
      expect(JSON.stringify(access)).not.toContain("full-ana");
    } finally {
      cp.close();
    }
  });

  test("ignores the case of the viewer's email", async () => {
    const cp = await createInMemoryControlPlaneStore();
    try {
      const { anaWs, leo } = await twoOwners(cp);
      await cp.setWorkspaceReadOnlyToken(anaWs.id, "ro-ana");
      await cp.recordGrant(leo.id, anaWs.id, "viewer");

      const access = await cp.readViewerAccess({
        viewerEmail: "  Leo@Example.COM ",
        workspaceId: anaWs.id,
      });
      expect(access?.readOnlyToken).toBe("ro-ana");
    } finally {
      cp.close();
    }
  });

  test("grants nothing to an owner, a stranger, a revoked viewer, or without a read-only token", async () => {
    const cp = await createInMemoryControlPlaneStore();
    try {
      const { anaWs, leo, leoWs } = await twoOwners(cp);
      const eva = await cp.findOrCreateUser("eva@example.com");
      await cp.recordGrant(leo.id, anaWs.id, "viewer");
      await cp.recordGrant(eva.id, leoWs.id, "viewer");

      // No read-only token yet: the viewer grant alone opens nothing.
      expect(
        await cp.readViewerAccess({
          viewerEmail: "leo@example.com",
          workspaceId: anaWs.id,
        }),
      ).toBeNull();

      await cp.setWorkspaceReadOnlyToken(anaWs.id, "ro-ana");
      // The owner's own grant is not a viewer grant.
      expect(
        await cp.readViewerAccess({
          viewerEmail: "ana@example.com",
          workspaceId: anaWs.id,
        }),
      ).toBeNull();
      // Another identity, and one viewing a DIFFERENT workspace.
      expect(
        await cp.readViewerAccess({
          viewerEmail: "eva@example.com",
          workspaceId: anaWs.id,
        }),
      ).toBeNull();
      expect(
        await cp.readViewerAccess({
          viewerEmail: "nobody@example.com",
          workspaceId: anaWs.id,
        }),
      ).toBeNull();
      // Revoked.
      await cp.revokeViewerGrant(anaWs.id, leo.id);
      expect(
        await cp.readViewerAccess({
          viewerEmail: "leo@example.com",
          workspaceId: anaWs.id,
        }),
      ).toBeNull();
    } finally {
      cp.close();
    }
  });

  test("the read-only token is sealed at rest like the full one", async () => {
    process.env.WORTHLINE_ENCRYPTION_KEY = "test-key-for-read-only-token";
    const dir = mkdtempSync(join(tmpdir(), "worthline-cp-ro-sealed-"));
    tempDirs.push(dir);
    const url = `file:${join(dir, "control-plane.sqlite")}`;
    const cp = await createControlPlaneStore({ url });
    try {
      const { anaWs } = await twoOwners(cp as AdminControlPlaneStore);
      await cp.setWorkspaceReadOnlyToken(anaWs.id, "ro-ana-plaintext");

      const raw = openLibsqlClient({ url });
      const stored = await raw.execute({
        sql: "SELECT db_read_only_token FROM workspaces WHERE id = ?",
        args: [anaWs.id],
      });
      raw.close();
      const column = String(stored.rows[0]?.["db_read_only_token"]);
      expect(column).not.toContain("ro-ana-plaintext");
      expect(column.startsWith("wlsec1:")).toBe(true);

      const [owned] = await cp.listOwnedWorkspacesForUser(
        (await cp.findUserByEmail("ana@example.com"))!.id,
      );
      expect(owned?.hasReadOnlyToken).toBe(true);
    } finally {
      cp.close();
    }
  });

  test("the read-only token is set once: a second writer gets the one in force", async () => {
    const cp = await createInMemoryControlPlaneStore();
    try {
      const { anaWs, leo } = await twoOwners(cp);
      await cp.recordGrant(leo.id, anaWs.id, "viewer");

      expect(await cp.setWorkspaceReadOnlyToken(anaWs.id, "ro-first")).toBe("ro-first");
      expect(await cp.setWorkspaceReadOnlyToken(anaWs.id, "ro-second")).toBe("ro-first");
      expect(
        (
          await cp.readViewerAccess({
            viewerEmail: "leo@example.com",
            workspaceId: anaWs.id,
          })
        )?.readOnlyToken,
      ).toBe("ro-first");
    } finally {
      cp.close();
    }
  });

  test("reading a viewer's access is ONE statement — it runs on every viewer request", async () => {
    const dir = mkdtempSync(join(tmpdir(), "worthline-cp-ro-one-query-"));
    tempDirs.push(dir);
    const url = `file:${join(dir, "control-plane.sqlite")}`;
    const cp = await createControlPlaneStore({ url });
    const { anaWs, leo } = await twoOwners(cp as AdminControlPlaneStore);
    await cp.setWorkspaceReadOnlyToken(anaWs.id, "ro-ana");
    await cp.recordGrant(leo.id, anaWs.id, "viewer");
    cp.close();

    const statements: string[] = [];
    const raw = openLibsqlClient({ url });
    const tenancy = createTenancyDirectory(
      instrumentClient(raw, (sql) => statements.push(sql)),
      () => "unused-id",
    );
    try {
      const granted = await tenancy.readViewerAccess({
        viewerEmail: "leo@example.com",
        workspaceId: anaWs.id,
      });
      expect(granted?.readOnlyToken).toBe("ro-ana");
      expect(statements).toHaveLength(1);

      statements.length = 0;
      expect(
        await tenancy.readViewerAccess({
          viewerEmail: "nobody@example.com",
          workspaceId: anaWs.id,
        }),
      ).toBeNull();
      expect(statements).toHaveLength(1);
    } finally {
      raw.close();
    }
  });
});

describe("tenancy · the viewer grant is capped atomically (#1841)", () => {
  test("records a viewer under the cap, and says why it did not otherwise", async () => {
    const dir = mkdtempSync(join(tmpdir(), "worthline-cp-viewer-cap-"));
    tempDirs.push(dir);
    const url = `file:${join(dir, "control-plane.sqlite")}`;
    const cp = await createControlPlaneStore({ url });
    const { ana, anaWs, leo } = await twoOwners(cp as AdminControlPlaneStore);
    const eva = await cp.findOrCreateUser("eva@example.com");
    const ines = await cp.findOrCreateUser("ines@example.com");
    const legacy = await cp.findOrCreateUser("legacy@example.com");
    cp.close();
    const raw = openLibsqlClient({ url });
    await raw.execute({
      sql: "INSERT INTO grants (user_id, workspace_id, role) VALUES (?, ?, 'orphaned-owner')",
      args: [legacy.id, anaWs.id],
    });
    raw.close();

    const reopened = await createControlPlaneStore({ url });
    try {
      expect(await reopened.recordViewerGrant(leo.id, anaWs.id, 2)).toBe("recorded");
      expect(await reopened.recordViewerGrant(leo.id, anaWs.id, 2)).toBe(
        "already-viewer",
      );
      expect(await reopened.recordViewerGrant(ana.id, anaWs.id, 2)).toBe(
        "conflicting-grant",
      );
      expect(await reopened.recordViewerGrant(legacy.id, anaWs.id, 2)).toBe(
        "conflicting-grant",
      );
      expect(await reopened.recordViewerGrant(eva.id, anaWs.id, 2)).toBe("recorded");
      expect(await reopened.recordViewerGrant(ines.id, anaWs.id, 2)).toBe("viewer-limit");
      expect(await reopened.readGrant(ines.id, anaWs.id)).toBeNull();
      expect((await reopened.readGrant(ana.id, anaWs.id))?.role).toBe("owner");
    } finally {
      reopened.close();
    }
  });
});

describe("tenancy · users are found whatever the case of their email (#1841)", () => {
  test("find and find-or-create reuse the existing row across capitalisations", async () => {
    const cp = await createInMemoryControlPlaneStore();
    try {
      const foo = await cp.findOrCreateUser("Foo@X.com");

      expect((await cp.findUserByEmail("foo@x.com"))?.id).toBe(foo.id);
      expect((await cp.findUserByEmail(" FOO@x.COM "))?.id).toBe(foo.id);
      const again = await cp.findOrCreateUser("foo@x.com");
      expect(again.id).toBe(foo.id);
      // The stored address keeps the case it was first written with.
      expect(again.email).toBe("Foo@X.com");
    } finally {
      cp.close();
    }
  });
});
