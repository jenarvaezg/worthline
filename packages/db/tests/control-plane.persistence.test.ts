import { createInMemoryControlPlaneStore } from "@db/control-plane";
import { describe, expect, test } from "vitest";

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

  test("daily capture run finalization is idempotent by date", async () => {
    const cp = await createInMemoryControlPlaneStore();
    try {
      expect(await cp.hasDailyCaptureRun("2026-06-25")).toBe(false);

      await cp.recordDailyCaptureRun("2026-06-25", "2026-06-25T21:00:00.000Z");
      expect(await cp.hasDailyCaptureRun("2026-06-25")).toBe(true);

      await cp.recordDailyCaptureRun("2026-06-25", "2026-06-25T22:00:00.000Z");
      expect(await cp.hasDailyCaptureRun("2026-06-25")).toBe(true);
      expect(await cp.hasDailyCaptureRun("2026-06-26")).toBe(false);
    } finally {
      cp.close();
    }
  });

  test("benchmark prices upsert by series and month in the control plane", async () => {
    const cp = await createInMemoryControlPlaneStore();
    try {
      await cp.upsertBenchmarkPrices("ipc-es", [
        { dateKey: "2024-02-01", value: "105.2" },
        { dateKey: "2024-01-01", value: "100" },
      ]);
      await cp.upsertBenchmarkPrices("ipc-es", [
        { dateKey: "2024-02-01", value: "105.4" },
      ]);
      await cp.upsertBenchmarkPrices("stoxx-600", [
        { dateKey: "2024-01-01", value: "492.1" },
      ]);

      expect(await cp.readBenchmarkPrices("ipc-es")).toEqual([
        { seriesId: "ipc-es", dateKey: "2024-01-01", value: "100" },
        { seriesId: "ipc-es", dateKey: "2024-02-01", value: "105.4" },
      ]);
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

  test("get-workspace-with-owner resolves the owner's email by workspace id (#697)", async () => {
    const cp = await createInMemoryControlPlaneStore();
    try {
      const ana = await cp.findOrCreateUser("ana@example.com");
      const ws = await cp.createWorkspace({
        dbName: "wl-ana",
        dbUrl: "libsql://wl-ana.turso.io",
      });
      await cp.recordGrant(ana.id, ws.id);

      const found = await cp.getWorkspaceWithOwner(ws.id);
      expect(found).toMatchObject({
        id: ws.id,
        dbUrl: "libsql://wl-ana.turso.io",
        ownerEmail: "ana@example.com",
      });
    } finally {
      cp.close();
    }
  });

  test("get-workspace-with-owner returns null for an unknown workspace id (#697)", async () => {
    const cp = await createInMemoryControlPlaneStore();
    try {
      expect(await cp.getWorkspaceWithOwner("ghost")).toBeNull();
    } finally {
      cp.close();
    }
  });

  test("get-workspace-with-owner returns a null ownerEmail for a dangling workspace with no grant (#697)", async () => {
    const cp = await createInMemoryControlPlaneStore();
    try {
      const ws = await cp.createWorkspace({
        dbName: "wl-orphan",
        dbUrl: "libsql://wl-orphan.turso.io",
      });

      const found = await cp.getWorkspaceWithOwner(ws.id);
      expect(found).toMatchObject({ id: ws.id, ownerEmail: null });
    } finally {
      cp.close();
    }
  });

  test("list-workspaces-with-owners returns every workspace with its owner's email, oldest first (#697)", async () => {
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

      const all = await cp.listWorkspacesWithOwners();
      expect(all.map((w) => ({ id: w.id, ownerEmail: w.ownerEmail }))).toEqual([
        { id: anaWs.id, ownerEmail: "ana@example.com" },
        { id: leoWs.id, ownerEmail: "leo@example.com" },
      ]);
    } finally {
      cp.close();
    }
  });

  test("a user cannot own two workspaces — a second owner grant is rejected (#733)", async () => {
    const cp = await createInMemoryControlPlaneStore();
    try {
      const ana = await cp.findOrCreateUser("ana@example.com");
      const first = await cp.createWorkspace({
        dbName: "wl-ana",
        dbUrl: "libsql://wl-ana.turso.io",
      });
      const second = await cp.createWorkspace({
        dbName: "wl-ana-2",
        dbUrl: "libsql://wl-ana-2.turso.io",
      });
      await cp.recordGrant(ana.id, first.id);

      await expect(cp.recordGrant(ana.id, second.id)).rejects.toThrow(/UNIQUE/i);
      expect(await cp.listWorkspacesForUser(ana.id)).toHaveLength(1);
    } finally {
      cp.close();
    }
  });

  test("the one-owner rule does not cap non-owner roles (#733)", async () => {
    const cp = await createInMemoryControlPlaneStore();
    try {
      const ana = await cp.findOrCreateUser("ana@example.com");
      const own = await cp.createWorkspace({
        dbName: "wl-ana",
        dbUrl: "libsql://wl-ana.turso.io",
      });
      const shared = await cp.createWorkspace({
        dbName: "wl-shared",
        dbUrl: "libsql://wl-shared.turso.io",
      });
      await cp.recordGrant(ana.id, own.id);

      // A future sharing flow can still grant the same user other workspaces
      // under non-owner roles.
      await cp.recordGrant(ana.id, shared.id, "viewer");
      expect(await cp.listWorkspacesForUser(ana.id)).toHaveLength(2);
    } finally {
      cp.close();
    }
  });

  test("delete-workspace removes the row — the provisioner's loser cleanup (#733)", async () => {
    const cp = await createInMemoryControlPlaneStore();
    try {
      const ws = await cp.createWorkspace({
        dbName: "wl-orphan",
        dbUrl: "libsql://wl-orphan.turso.io",
      });
      await cp.deleteWorkspace(ws.id);
      expect(await cp.listAllWorkspaces()).toHaveLength(0);
    } finally {
      cp.close();
    }
  });

  test("concurrent find-or-create calls for the same email converge on one user (#733)", async () => {
    const cp = await createInMemoryControlPlaneStore();
    try {
      const [a, b] = await Promise.all([
        cp.findOrCreateUser("ana@example.com"),
        cp.findOrCreateUser("ana@example.com"),
      ]);
      expect(b.id).toBe(a.id);
    } finally {
      cp.close();
    }
  });
});
