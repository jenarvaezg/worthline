/**
 * `POST /viewing` against a real control plane (#1843): only a VIEWER grant
 * opens a viewer session. An owner posting their own workspace id — an owner
 * grant, not a viewer one — gets no cookie, and neither does someone with no
 * grant at all. The lookup is the real `lookupViewerAccess`; only the session
 * email and the control-plane connection are supplied by the test.
 */

import { createInMemoryControlPlaneStore } from "@worthline/db";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const state = vi.hoisted(() => ({
  sessionEmail: null as string | null,
  store: null as unknown,
}));

vi.mock("@web/read-store-target", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@web/read-store-target")>()),
  readSessionEmail: async () => state.sessionEmail,
}));
vi.mock("@web/control-plane-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@web/control-plane-store")>()),
  // biome-ignore lint/suspicious/noExplicitAny: forwards whatever `run` the lookup passes
  withControlPlaneStore: async (run: (store: any) => unknown) => run(state.store),
}));

import { POST } from "./route";
import { VIEWING_COOKIE_NAME } from "./viewing-cookie";

function viewingPost(workspaceId: string): NextRequest {
  return new NextRequest("http://127.0.0.1:3001/viewing", {
    body: `workspaceId=${encodeURIComponent(workspaceId)}`,
    headers: { "content-type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
}

let seeded: { close(): void };
let jorgeWorkspaceId = "";

beforeEach(async () => {
  vi.stubEnv("WORTHLINE_CONTROL_PLANE_DB_URL", "libsql://control-plane.turso.io");
  const cp = await createInMemoryControlPlaneStore();
  const jorge = await cp.findOrCreateUser("jorge@example.com");
  const ws = await cp.createWorkspace({
    dbAuthToken: "full-jorge",
    dbName: "wl-jorge",
    dbUrl: "libsql://wl-jorge.turso.io",
  });
  await cp.recordGrant(jorge.id, ws.id);
  await cp.setWorkspaceReadOnlyToken(ws.id, "read-only-jorge");
  const lucia = await cp.findOrCreateUser("lucia@example.com");
  await cp.recordGrant(lucia.id, ws.id, "viewer");
  state.store = cp;
  seeded = cp;
  jorgeWorkspaceId = ws.id;
});

afterEach(() => {
  seeded.close();
  vi.unstubAllEnvs();
});

describe("POST /viewing · grants from the control plane (#1843)", () => {
  test("the owner's own grant is not a viewer grant: no cookie, back to /ajustes", async () => {
    state.sessionEmail = "jorge@example.com";

    const response = await POST(viewingPost(jorgeWorkspaceId));

    expect(response.headers.get("location")).toBe("/ajustes");
    expect(response.cookies.get(VIEWING_COOKIE_NAME)).toBeUndefined();
  });

  test("someone with no grant on the workspace gets no cookie", async () => {
    state.sessionEmail = "mallory@example.com";

    const response = await POST(viewingPost(jorgeWorkspaceId));

    expect(response.headers.get("location")).toBe("/ajustes");
    expect(response.cookies.get(VIEWING_COOKIE_NAME)).toBeUndefined();
  });

  test("a viewer grant sets the cookie", async () => {
    state.sessionEmail = "lucia@example.com";

    const response = await POST(viewingPost(jorgeWorkspaceId));

    expect(response.headers.get("location")).toBe("/app");
    expect(response.cookies.get(VIEWING_COOKIE_NAME)?.value).toBe(jorgeWorkspaceId);
  });
});
