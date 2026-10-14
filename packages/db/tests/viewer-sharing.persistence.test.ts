/**
 * The sharing door (#1841, S1 of #1718, ADR 0112): an owner gives and takes a
 * read-only view of THEIR workspace. The workspace is never a parameter — it is
 * the owner's own — and the read-only token exists before any grant does.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AdminControlPlaneStore,
  createControlPlaneStore,
  createInMemoryControlPlaneStore,
} from "@db/control-plane";
import { openLibsqlClient } from "@db/libsql-client";
import type { TursoPort, TursoTokenAuthorization } from "@db/provisioner";
import {
  MAX_VIEWERS_PER_WORKSPACE,
  revokeWorkspaceReadOnly,
  ShareWorkspaceRefusedError,
  shareWorkspaceReadOnly,
} from "@db/viewer-sharing";
import { afterAll, afterEach, describe, expect, test } from "vitest";

const tempDirs: string[] = [];
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { force: true, recursive: true });
});

/** A Turso port that only mints tokens, recording every one it was asked for. */
function fakeTurso(options: { failTokens?: boolean } = {}) {
  const minted: Array<{ name: string; authorization: TursoTokenAuthorization }> = [];
  const port: TursoPort = {
    async createDatabase() {
      throw new Error("sharing never creates a database");
    },
    async createDatabaseToken(name, authorization) {
      if (options.failTokens) throw new Error("Turso is down");
      minted.push({ authorization, name });
      return { jwt: `${authorization}-token-for-${name}` };
    },
  };
  return { minted, port };
}

/** Ana owns `wl-ana` with its full token. */
async function anaOwnsAWorkspace(cp: AdminControlPlaneStore) {
  const ana = await cp.findOrCreateUser("ana@example.com");
  const workspace = await cp.createWorkspace({
    dbAuthToken: "full-ana",
    dbName: "wl-ana",
    dbUrl: "libsql://wl-ana.turso.io",
  });
  await cp.recordGrant(ana.id, workspace.id);
  return { ana, workspace };
}

async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ShareWorkspaceRefusedError) return error.reason;
    throw error;
  }
  throw new Error("expected the share to be refused");
}

describe("shareWorkspaceReadOnly (#1841)", () => {
  test("shares the owner's workspace: mints a read-only token, then the viewer grant", async () => {
    const cp = await createInMemoryControlPlaneStore();
    const turso = fakeTurso();
    try {
      const { workspace } = await anaOwnsAWorkspace(cp);

      const shared = await shareWorkspaceReadOnly(
        { controlPlane: cp, turso: turso.port },
        { ownerEmail: "ana@example.com", viewerEmail: "  Leo@Example.com " },
      );

      expect(shared).toMatchObject({
        created: true,
        viewer: { email: "leo@example.com" },
        workspaceId: workspace.id,
      });
      expect(turso.minted).toEqual([{ authorization: "read-only", name: "wl-ana" }]);
      const access = await cp.readViewerAccess({
        viewerEmail: "leo@example.com",
        workspaceId: workspace.id,
      });
      expect(access).toMatchObject({
        ownerEmail: "ana@example.com",
        readOnlyToken: "read-only-token-for-wl-ana",
      });
    } finally {
      cp.close();
    }
  });

  test("the viewer gets a bare user row: no workspace, no trial", async () => {
    const cp = await createInMemoryControlPlaneStore();
    const turso = fakeTurso();
    try {
      await anaOwnsAWorkspace(cp);
      const { viewer } = await shareWorkspaceReadOnly(
        { controlPlane: cp, turso: turso.port },
        { ownerEmail: "ana@example.com", viewerEmail: "leo@example.com" },
      );

      expect(await cp.listOwnedWorkspacesForUser(viewer.userId)).toEqual([]);
      expect(await cp.listAllWorkspaces()).toHaveLength(1);
      expect(await cp.listWorkspaceEntitlements()).toEqual([]);
    } finally {
      cp.close();
    }
  });

  test("sharing twice with the same viewer leaves one grant and mints one token", async () => {
    const cp = await createInMemoryControlPlaneStore();
    const turso = fakeTurso();
    try {
      const { workspace } = await anaOwnsAWorkspace(cp);
      const deps = { controlPlane: cp, turso: turso.port };
      await shareWorkspaceReadOnly(deps, {
        ownerEmail: "ana@example.com",
        viewerEmail: "leo@example.com",
      });
      const again = await shareWorkspaceReadOnly(deps, {
        ownerEmail: "ana@example.com",
        viewerEmail: "LEO@example.com",
      });

      expect(again.created).toBe(false);
      expect(await cp.listViewersOfWorkspace(workspace.id)).toHaveLength(1);
      expect(turso.minted).toHaveLength(1);
    } finally {
      cp.close();
    }
  });

  test("a second viewer reuses the workspace's read-only token", async () => {
    const cp = await createInMemoryControlPlaneStore();
    const turso = fakeTurso();
    try {
      const { workspace } = await anaOwnsAWorkspace(cp);
      const deps = { controlPlane: cp, turso: turso.port };
      await shareWorkspaceReadOnly(deps, {
        ownerEmail: "ana@example.com",
        viewerEmail: "leo@example.com",
      });
      await shareWorkspaceReadOnly(deps, {
        ownerEmail: "ana@example.com",
        viewerEmail: "eva@example.com",
      });

      expect(turso.minted).toHaveLength(1);
      expect(
        (await cp.listViewersOfWorkspace(workspace.id)).map((viewer) => viewer.email),
      ).toEqual(["leo@example.com", "eva@example.com"]);
    } finally {
      cp.close();
    }
  });

  test("refuses to share with oneself, whatever the case", async () => {
    const cp = await createInMemoryControlPlaneStore();
    const turso = fakeTurso();
    try {
      const { workspace } = await anaOwnsAWorkspace(cp);

      expect(
        await refusal(
          shareWorkspaceReadOnly(
            { controlPlane: cp, turso: turso.port },
            { ownerEmail: "ana@example.com", viewerEmail: " ANA@example.com" },
          ),
        ),
      ).toBe("self-share");
      expect(await cp.listViewersOfWorkspace(workspace.id)).toEqual([]);
      expect(turso.minted).toEqual([]);
    } finally {
      cp.close();
    }
  });

  test.each([
    "",
    "   ",
    "leo",
    "leo@",
    "@example.com",
    "leo@example",
    "leo example@example.com",
    "leo@@example.com",
  ])("refuses an invalid email %j", async (viewerEmail) => {
    const cp = await createInMemoryControlPlaneStore();
    const turso = fakeTurso();
    try {
      const { workspace } = await anaOwnsAWorkspace(cp);

      expect(
        await refusal(
          shareWorkspaceReadOnly(
            { controlPlane: cp, turso: turso.port },
            { ownerEmail: "ana@example.com", viewerEmail },
          ),
        ),
      ).toBe("invalid-email");
      expect(await cp.listViewersOfWorkspace(workspace.id)).toEqual([]);
    } finally {
      cp.close();
    }
  });

  test(`refuses a viewer beyond the ${MAX_VIEWERS_PER_WORKSPACE}th`, async () => {
    const cp = await createInMemoryControlPlaneStore();
    const turso = fakeTurso();
    try {
      const { workspace } = await anaOwnsAWorkspace(cp);
      const deps = { controlPlane: cp, turso: turso.port };
      for (let index = 1; index <= MAX_VIEWERS_PER_WORKSPACE; index += 1) {
        await shareWorkspaceReadOnly(deps, {
          ownerEmail: "ana@example.com",
          viewerEmail: `viewer${index}@example.com`,
        });
      }

      expect(
        await refusal(
          shareWorkspaceReadOnly(deps, {
            ownerEmail: "ana@example.com",
            viewerEmail: "one-too-many@example.com",
          }),
        ),
      ).toBe("viewer-limit");
      expect(await cp.listViewersOfWorkspace(workspace.id)).toHaveLength(
        MAX_VIEWERS_PER_WORKSPACE,
      );
      expect(await cp.findUserByEmail("one-too-many@example.com")).toBeNull();

      // Re-sharing with someone already in is still idempotent at the cap.
      const again = await shareWorkspaceReadOnly(deps, {
        ownerEmail: "ana@example.com",
        viewerEmail: "viewer1@example.com",
      });
      expect(again.created).toBe(false);
    } finally {
      cp.close();
    }
  });

  test("a failed token mint leaves no grant and no user row", async () => {
    const cp = await createInMemoryControlPlaneStore();
    try {
      const { workspace } = await anaOwnsAWorkspace(cp);

      await expect(
        shareWorkspaceReadOnly(
          { controlPlane: cp, turso: fakeTurso({ failTokens: true }).port },
          { ownerEmail: "ana@example.com", viewerEmail: "leo@example.com" },
        ),
      ).rejects.toThrow(/Turso is down/);

      expect(await cp.listViewersOfWorkspace(workspace.id)).toEqual([]);
      expect(await cp.findUserByEmail("leo@example.com")).toBeNull();
      expect((await cp.listAllWorkspaces())[0]?.hasReadOnlyToken).toBe(false);
    } finally {
      cp.close();
    }
  });

  test("an identity that owns nothing has nothing to share — a viewer grant is not ownership", async () => {
    const cp = await createInMemoryControlPlaneStore();
    const turso = fakeTurso();
    try {
      const { workspace } = await anaOwnsAWorkspace(cp);
      const deps = { controlPlane: cp, turso: turso.port };
      await shareWorkspaceReadOnly(deps, {
        ownerEmail: "ana@example.com",
        viewerEmail: "leo@example.com",
      });

      // Leo only VIEWS Ana's workspace: he cannot pass it on.
      expect(
        await refusal(
          shareWorkspaceReadOnly(deps, {
            ownerEmail: "leo@example.com",
            viewerEmail: "eva@example.com",
          }),
        ),
      ).toBe("no-owned-workspace");
      expect(
        await refusal(
          shareWorkspaceReadOnly(deps, {
            ownerEmail: "stranger@example.com",
            viewerEmail: "eva@example.com",
          }),
        ),
      ).toBe("no-owned-workspace");
      expect(
        (await cp.listViewersOfWorkspace(workspace.id)).map((viewer) => viewer.email),
      ).toEqual(["leo@example.com"]);
    } finally {
      cp.close();
    }
  });

  describe("with an encryption key", () => {
    const savedKey = process.env.WORTHLINE_ENCRYPTION_KEY;
    afterEach(() => {
      if (savedKey === undefined) delete process.env.WORTHLINE_ENCRYPTION_KEY;
      else process.env.WORTHLINE_ENCRYPTION_KEY = savedKey;
    });

    test("the raw column never holds the read-only token in clear", async () => {
      process.env.WORTHLINE_ENCRYPTION_KEY = "test-key-for-sharing";
      const dir = mkdtempSync(join(tmpdir(), "worthline-share-sealed-"));
      tempDirs.push(dir);
      const url = `file:${join(dir, "control-plane.sqlite")}`;
      const cp = await createControlPlaneStore({ url });
      try {
        const { workspace } = await anaOwnsAWorkspace(cp as AdminControlPlaneStore);
        await shareWorkspaceReadOnly(
          { controlPlane: cp, turso: fakeTurso().port },
          { ownerEmail: "ana@example.com", viewerEmail: "leo@example.com" },
        );

        const raw = openLibsqlClient({ url });
        const stored = await raw.execute({
          sql: "SELECT db_read_only_token FROM workspaces WHERE id = ?",
          args: [workspace.id],
        });
        raw.close();
        expect(String(stored.rows[0]?.["db_read_only_token"])).not.toContain(
          "read-only-token-for-wl-ana",
        );
        expect(
          (
            await cp.readViewerAccess({
              viewerEmail: "leo@example.com",
              workspaceId: workspace.id,
            })
          )?.readOnlyToken,
        ).toBe("read-only-token-for-wl-ana");
      } finally {
        cp.close();
      }
    });
  });
});

describe("revokeWorkspaceReadOnly (#1841)", () => {
  test("the owner takes a viewer's access back", async () => {
    const cp = await createInMemoryControlPlaneStore();
    try {
      const { workspace } = await anaOwnsAWorkspace(cp);
      const { viewer } = await shareWorkspaceReadOnly(
        { controlPlane: cp, turso: fakeTurso().port },
        { ownerEmail: "ana@example.com", viewerEmail: "leo@example.com" },
      );

      expect(
        await revokeWorkspaceReadOnly(
          { controlPlane: cp },
          { ownerEmail: "ana@example.com", viewerUserId: viewer.userId },
        ),
      ).toBe(true);
      expect(
        await cp.readViewerAccess({
          viewerEmail: "leo@example.com",
          workspaceId: workspace.id,
        }),
      ).toBeNull();
    } finally {
      cp.close();
    }
  });

  test("only reaches the owner's own workspace, and never an owner grant", async () => {
    const cp = await createInMemoryControlPlaneStore();
    try {
      const { ana, workspace } = await anaOwnsAWorkspace(cp);
      const { viewer } = await shareWorkspaceReadOnly(
        { controlPlane: cp, turso: fakeTurso().port },
        { ownerEmail: "ana@example.com", viewerEmail: "leo@example.com" },
      );

      // The viewer cannot revoke himself through the owner's door, nor can a
      // stranger; the owner's id never deletes her own grant.
      expect(
        await revokeWorkspaceReadOnly(
          { controlPlane: cp },
          { ownerEmail: "leo@example.com", viewerUserId: viewer.userId },
        ),
      ).toBe(false);
      expect(
        await revokeWorkspaceReadOnly(
          { controlPlane: cp },
          { ownerEmail: "stranger@example.com", viewerUserId: viewer.userId },
        ),
      ).toBe(false);
      expect(
        await revokeWorkspaceReadOnly(
          { controlPlane: cp },
          { ownerEmail: "ana@example.com", viewerUserId: ana.id },
        ),
      ).toBe(false);

      expect((await cp.readGrant(ana.id, workspace.id))?.role).toBe("owner");
      expect(await cp.listViewersOfWorkspace(workspace.id)).toHaveLength(1);
    } finally {
      cp.close();
    }
  });
});
