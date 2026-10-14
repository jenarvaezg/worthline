/**
 * The viewer session as `readStoreTarget` resolves it (#1843, ADR 0112): the
 * `wl_viewing` cookie names a workspace, and EVERY request re-reads the viewer
 * grant of this session's email for it, through one control-plane lookup. The
 * cookie grants nothing by itself; without it, nothing extra is read.
 *
 * Driven end-to-end through `readStoreTarget` with a real in-memory control
 * plane: the session (`@web/auth`) and the cookie jar (`next/headers`) are the
 * request's inputs, and `withControlPlaneStore` is spied so a test can say
 * «no control-plane call at all».
 */

import { createInMemoryControlPlaneStore } from "@worthline/db";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

type Session = { user?: { email?: string | null }; workspace?: unknown } | null;

const request = vi.hoisted(() => ({
  cookies: new Map<string, string>(),
  session: null as Session,
}));

const controlPlane = vi.hoisted(() => ({
  store: null as unknown,
  // biome-ignore lint/suspicious/noExplicitAny: the spy forwards whatever `run` the reader passes
  withControlPlaneStore: vi.fn(async (run: (store: any) => unknown) =>
    run(controlPlane.store),
  ),
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => {
      const value = request.cookies.get(name);
      return value === undefined ? undefined : { name, value };
    },
  }),
}));
vi.mock("@web/auth", () => ({ auth: async () => request.session }));
vi.mock("@web/control-plane-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@web/control-plane-store")>()),
  withControlPlaneStore: controlPlane.withControlPlaneStore,
}));

import { IMPERSONATE_COOKIE_NAME } from "@web/admin/impersonate-cookie";
import { DEMO_PERSONA_COOKIE_NAME } from "@web/demo/demo-context";
import { readStoreTarget } from "@web/read-store-target";
import { VIEWING_COOKIE_NAME } from "@web/viewing/viewing-cookie";

const LUCIA = {
  user: { email: "lucia@example.com" },
  workspace: {
    id: "ws-lucia",
    dbUrl: "libsql://wl-lucia.turso.io",
    dbAuthToken: "full-lucia",
  },
};
const ADMIN = {
  user: { email: "admin@example.com" },
  workspace: {
    id: "ws-admin",
    dbUrl: "libsql://wl-admin.turso.io",
    dbAuthToken: "full-admin",
  },
};
const OWN_LUCIA = {
  kind: "authenticated",
  workspaceId: "ws-lucia",
  dbUrl: "libsql://wl-lucia.turso.io",
  token: "full-lucia",
};

/** Jorge owns a workspace and shared it with Lucía; Mallory owns one, shared with no one. */
async function seedControlPlane() {
  const cp = await createInMemoryControlPlaneStore();
  const jorge = await cp.findOrCreateUser("jorge@example.com");
  const jorgeWs = await cp.createWorkspace({
    dbAuthToken: "full-jorge",
    dbName: "wl-jorge",
    dbUrl: "libsql://wl-jorge.turso.io",
  });
  await cp.recordGrant(jorge.id, jorgeWs.id);
  await cp.setWorkspaceReadOnlyToken(jorgeWs.id, "read-only-jorge");
  const lucia = await cp.findOrCreateUser("lucia@example.com");
  await cp.recordGrant(lucia.id, jorgeWs.id, "viewer");

  const mallory = await cp.findOrCreateUser("mallory@example.com");
  const malloryWs = await cp.createWorkspace({
    dbAuthToken: "full-mallory",
    dbName: "wl-mallory",
    dbUrl: "libsql://wl-mallory.turso.io",
  });
  await cp.recordGrant(mallory.id, malloryWs.id);
  await cp.setWorkspaceReadOnlyToken(malloryWs.id, "read-only-mallory");

  return { cp, jorgeWs, lucia, malloryWs };
}

let seeded: Awaited<ReturnType<typeof seedControlPlane>>;

beforeEach(async () => {
  vi.stubEnv("AUTH_GOOGLE_ID", "google-id");
  vi.stubEnv("AUTH_GOOGLE_SECRET", "google-secret");
  vi.stubEnv("WORTHLINE_ADMIN_EMAIL", "admin@example.com");
  vi.stubEnv("WORTHLINE_CONTROL_PLANE_DB_URL", "libsql://control-plane.turso.io");
  vi.stubEnv("WORTHLINE_DB_AUTH_TOKEN", "group-token");
  seeded = await seedControlPlane();
  controlPlane.store = seeded.cp;
  controlPlane.withControlPlaneStore.mockClear();
  request.cookies.clear();
  request.session = null;
});

afterEach(() => {
  seeded.cp.close();
  vi.unstubAllEnvs();
});

describe("readStoreTarget · the viewer cookie (#1843)", () => {
  test("a cookie backed by this session's grant opens the shared workspace read-only", async () => {
    request.session = LUCIA;
    request.cookies.set(VIEWING_COOKIE_NAME, seeded.jorgeWs.id);

    expect(await readStoreTarget()).toEqual({
      kind: "authenticated",
      workspaceId: seeded.jorgeWs.id,
      dbUrl: "libsql://wl-jorge.turso.io",
      token: "read-only-jorge",
      sharedByEmail: "jorge@example.com",
    });
    expect(controlPlane.withControlPlaneStore).toHaveBeenCalledTimes(1);
  });

  test("a forged cookie for a workspace with no grant opens the session's own workspace", async () => {
    request.session = LUCIA;
    request.cookies.set(VIEWING_COOKIE_NAME, seeded.malloryWs.id);

    expect(await readStoreTarget()).toEqual(OWN_LUCIA);
  });

  test("a revoked grant falls back to the own workspace on the very next request", async () => {
    request.session = LUCIA;
    request.cookies.set(VIEWING_COOKIE_NAME, seeded.jorgeWs.id);
    expect(await readStoreTarget()).toMatchObject({ sharedByEmail: "jorge@example.com" });

    await seeded.cp.revokeViewerGrant(seeded.jorgeWs.id, seeded.lucia.id);

    expect(await readStoreTarget()).toEqual(OWN_LUCIA);
  });

  test("no session with the cookie is unauthenticated, and reads no grant", async () => {
    request.cookies.set(VIEWING_COOKIE_NAME, seeded.jorgeWs.id);

    expect(await readStoreTarget()).toEqual({ kind: "unauthenticated" });
    expect(controlPlane.withControlPlaneStore).not.toHaveBeenCalled();
  });

  test("a demo persona with the cookie stays the demo", async () => {
    request.cookies.set(DEMO_PERSONA_COOKIE_NAME, "familia");
    request.cookies.set(VIEWING_COOKIE_NAME, seeded.jorgeWs.id);

    expect(await readStoreTarget()).toEqual({
      kind: "demo",
      persona: "familia",
      now: "",
    });
  });

  test("an admin with both cookies impersonates", async () => {
    const admin = await seeded.cp.findOrCreateUser("admin@example.com");
    await seeded.cp.recordGrant(admin.id, seeded.jorgeWs.id, "viewer");
    request.session = ADMIN;
    request.cookies.set(VIEWING_COOKIE_NAME, seeded.jorgeWs.id);
    request.cookies.set(IMPERSONATE_COOKIE_NAME, seeded.malloryWs.id);

    expect(await readStoreTarget()).toEqual({
      kind: "authenticated",
      workspaceId: seeded.malloryWs.id,
      dbUrl: "libsql://wl-mallory.turso.io",
      token: "full-mallory",
      impersonatedEmail: "mallory@example.com",
    });
  });

  test("a lookup that answers for another email is ignored", async () => {
    request.session = LUCIA;
    request.cookies.set(VIEWING_COOKIE_NAME, seeded.jorgeWs.id);
    controlPlane.withControlPlaneStore.mockImplementationOnce(async (run) =>
      run({
        readViewerAccess: async () => ({
          dbUrl: "libsql://wl-jorge.turso.io",
          ownerEmail: "jorge@example.com",
          readOnlyToken: "read-only-jorge",
          viewerEmail: "mallory@example.com",
          workspaceId: seeded.jorgeWs.id,
        }),
      }),
    );

    expect(await readStoreTarget()).toEqual(OWN_LUCIA);
  });

  test("without the cookie there is no control-plane call at all", async () => {
    request.session = LUCIA;

    expect(await readStoreTarget()).toEqual(OWN_LUCIA);
    expect(controlPlane.withControlPlaneStore).not.toHaveBeenCalled();
  });
});
