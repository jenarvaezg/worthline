import { describe, expect, test } from "vitest";

import { createInMemoryControlPlaneStore } from "@db/control-plane";

describe("control-plane store", () => {
  test("find-or-create returns a user for a new email", async () => {
    const cp = await createInMemoryControlPlaneStore();
    try {
      const user = await cp.findOrCreateUser("ana@example.com");
      expect(user.email).toBe("ana@example.com");
      expect(user.id).toBeTruthy();
    } finally {
      cp.close();
    }
  });

  test("find-or-create is idempotent by email — same address, same user", async () => {
    const cp = await createInMemoryControlPlaneStore();
    try {
      const first = await cp.findOrCreateUser("ana@example.com");
      const second = await cp.findOrCreateUser("ana@example.com");
      expect(second.id).toBe(first.id);
    } finally {
      cp.close();
    }
  });

  test("find-user-by-email reads an existing user without creating one", async () => {
    const cp = await createInMemoryControlPlaneStore();
    try {
      // Read-only: a never-seen email resolves to null (the MCP path must not
      // provision — that stays on first web sign-in, ADR 0030).
      expect(await cp.findUserByEmail("ana@example.com")).toBeNull();

      const created = await cp.findOrCreateUser("ana@example.com");
      const found = await cp.findUserByEmail("ana@example.com");
      expect(found?.id).toBe(created.id);
      expect(found?.email).toBe("ana@example.com");
    } finally {
      cp.close();
    }
  });

  test("a granted workspace appears in the user's workspace list", async () => {
    const cp = await createInMemoryControlPlaneStore();
    try {
      const user = await cp.findOrCreateUser("ana@example.com");
      const ws = await cp.createWorkspace({
        dbName: "wl-ana",
        dbUrl: "libsql://wl-ana.turso.io",
      });
      await cp.recordGrant(user.id, ws.id);

      const list = await cp.listWorkspacesForUser(user.id);
      expect(list).toHaveLength(1);
      expect(list[0]).toMatchObject({
        id: ws.id,
        dbName: "wl-ana",
        dbUrl: "libsql://wl-ana.turso.io",
      });
    } finally {
      cp.close();
    }
  });

  test("read-grant returns the recorded grant, or null when absent", async () => {
    const cp = await createInMemoryControlPlaneStore();
    try {
      const user = await cp.findOrCreateUser("ana@example.com");
      const ws = await cp.createWorkspace({
        dbName: "wl-ana",
        dbUrl: "libsql://wl-ana.turso.io",
      });

      expect(await cp.readGrant(user.id, ws.id)).toBeNull();

      await cp.recordGrant(user.id, ws.id);
      const grant = await cp.readGrant(user.id, ws.id);
      expect(grant).toMatchObject({
        userId: user.id,
        workspaceId: ws.id,
        role: "owner",
      });
    } finally {
      cp.close();
    }
  });

  test("list-all-workspaces returns every workspace across all users (cron enumeration)", async () => {
    const cp = await createInMemoryControlPlaneStore();
    try {
      const ana = await cp.findOrCreateUser("ana@example.com");
      const leo = await cp.findOrCreateUser("leo@example.com");
      const anaWs = await cp.createWorkspace({
        dbName: "wl-ana",
        dbUrl: "libsql://wl-ana.turso.io",
      });
      const leoWs = await cp.createWorkspace({
        dbName: "wl-leo",
        dbUrl: "libsql://wl-leo.turso.io",
      });
      await cp.recordGrant(ana.id, anaWs.id);
      await cp.recordGrant(leo.id, leoWs.id);

      // The cron's system actor enumerates globally — not scoped to any user.
      const all = await cp.listAllWorkspaces();
      expect(all.map((w) => w.id).sort()).toEqual([anaWs.id, leoWs.id].sort());
      expect(all.find((w) => w.id === anaWs.id)?.dbUrl).toBe("libsql://wl-ana.turso.io");
    } finally {
      cp.close();
    }
  });

  test("two different accounts get isolated workspace lists", async () => {
    const cp = await createInMemoryControlPlaneStore();
    try {
      const ana = await cp.findOrCreateUser("ana@example.com");
      const leo = await cp.findOrCreateUser("leo@example.com");
      const anaWs = await cp.createWorkspace({
        dbName: "wl-ana",
        dbUrl: "libsql://wl-ana.turso.io",
      });
      const leoWs = await cp.createWorkspace({
        dbName: "wl-leo",
        dbUrl: "libsql://wl-leo.turso.io",
      });
      await cp.recordGrant(ana.id, anaWs.id);
      await cp.recordGrant(leo.id, leoWs.id);

      const anaList = await cp.listWorkspacesForUser(ana.id);
      expect(anaList.map((w) => w.id)).toEqual([anaWs.id]);
      expect(anaList.map((w) => w.id)).not.toContain(leoWs.id);
    } finally {
      cp.close();
    }
  });
});
