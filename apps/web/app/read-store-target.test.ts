/**
 * `lookupImpersonationTarget` tests (#697, ADR 0030). This is the async
 * control-plane wiring half of admin impersonation — it resolves a workspace
 * id (from the cookie) to a dbUrl + owner email, or null. It deliberately does
 * NOT decide who is allowed to use the result: that gate lives in
 * `resolveStoreTarget` (see `store-resolver.test.ts`), tested independently as
 * a pure function. Here we only assert the lookup itself: present/absent
 * cookie, control plane not configured, and an unknown workspace id.
 */
import { describe, expect, test } from "vitest";

import { createInMemoryControlPlaneStore } from "@worthline/db";

import { lookupImpersonationTarget } from "@web/read-store-target";

describe("lookupImpersonationTarget", () => {
  test("resolves the workspace's dbUrl and owner email for a known workspace id", async () => {
    const controlPlane = await createInMemoryControlPlaneStore();
    const user = await controlPlane.findOrCreateUser("target@example.com");
    const ws = await controlPlane.createWorkspace({
      dbName: "wl-target",
      dbUrl: "libsql://wl-target.turso.io",
    });
    await controlPlane.recordGrant(user.id, ws.id);

    const result = await lookupImpersonationTarget({
      workspaceId: ws.id,
      env: { WORTHLINE_CONTROL_PLANE_DB_URL: "libsql://control-plane.turso.io" },
      openControlPlane: async () => controlPlane,
    });

    expect(result).toEqual({
      workspaceId: ws.id,
      dbUrl: "libsql://wl-target.turso.io",
      email: "target@example.com",
    });
  });

  test("returns null when no workspace id (cookie absent) is given", async () => {
    const result = await lookupImpersonationTarget({
      workspaceId: undefined,
      env: { WORTHLINE_CONTROL_PLANE_DB_URL: "libsql://control-plane.turso.io" },
    });
    expect(result).toBeNull();
  });

  test("returns null when the control plane is not configured, even with a workspace id", async () => {
    const result = await lookupImpersonationTarget({
      workspaceId: "ws-target",
      env: {},
    });
    expect(result).toBeNull();
  });

  test("returns null for an unknown workspace id — a garbage/stale cookie fails closed", async () => {
    const controlPlane = await createInMemoryControlPlaneStore();

    const result = await lookupImpersonationTarget({
      workspaceId: "ghost",
      env: { WORTHLINE_CONTROL_PLANE_DB_URL: "libsql://control-plane.turso.io" },
      openControlPlane: async () => controlPlane,
    });

    expect(result).toBeNull();
  });

  test("closes the control-plane connection it opened after the lookup", async () => {
    const controlPlane = await createInMemoryControlPlaneStore();
    let closed = false;
    const spyingStore = new Proxy(controlPlane, {
      get(target, prop, receiver) {
        if (prop === "close") {
          return () => {
            closed = true;
            target.close();
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });

    await lookupImpersonationTarget({
      workspaceId: "ws-target",
      env: { WORTHLINE_CONTROL_PLANE_DB_URL: "libsql://control-plane.turso.io" },
      openControlPlane: async () => spyingStore,
    });

    expect(closed).toBe(true);
  });
});
