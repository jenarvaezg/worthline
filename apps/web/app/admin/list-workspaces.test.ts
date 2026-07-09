import { listAdminWorkspaces } from "@web/admin/list-workspaces";

import { createInMemoryControlPlaneStore } from "@worthline/db";
import { describe, expect, test } from "vitest";

describe("listAdminWorkspaces", () => {
  test("lists every workspace with its owner's email, oldest first", async () => {
    const controlPlane = await createInMemoryControlPlaneStore();
    const ana = await controlPlane.findOrCreateUser("ana@example.com");
    const leo = await controlPlane.findOrCreateUser("leo@example.com");
    const anaWs = await controlPlane.createWorkspace({
      dbName: "wl-ana",
      dbUrl: "libsql://wl-ana.turso.io",
    });
    const leoWs = await controlPlane.createWorkspace({
      dbName: "wl-leo",
      dbUrl: "libsql://wl-leo.turso.io",
    });
    await controlPlane.recordGrant(ana.id, anaWs.id);
    await controlPlane.recordGrant(leo.id, leoWs.id);

    const list = await listAdminWorkspaces(controlPlane);

    expect(list.map((w) => ({ id: w.id, ownerEmail: w.ownerEmail }))).toEqual([
      { id: anaWs.id, ownerEmail: "ana@example.com" },
      { id: leoWs.id, ownerEmail: "leo@example.com" },
    ]);
  });
});
