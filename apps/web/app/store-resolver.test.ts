import { describe, expect, test } from "vitest";

import { resolveStoreTarget } from "./store-resolver";

describe("resolveStoreTarget", () => {
  test("returns local when auth is not configured", () => {
    const result = resolveStoreTarget({
      env: {},
      session: null,
    });
    expect(result).toEqual({ kind: "local" });
  });

  test("returns unauthenticated when auth is configured but there is no session", () => {
    const result = resolveStoreTarget({
      env: {
        AUTH_GOOGLE_ID: "google-id",
        AUTH_GOOGLE_SECRET: "google-secret",
      },
      session: null,
    });
    expect(result).toEqual({ kind: "unauthenticated" });
  });

  test("returns authenticated with the signed-in user's own workspace from the session", () => {
    const result = resolveStoreTarget({
      env: {
        AUTH_GOOGLE_ID: "google-id",
        AUTH_GOOGLE_SECRET: "google-secret",
        WORTHLINE_DB_AUTH_TOKEN: "group-token",
      },
      session: {
        user: { email: "ana@example.com" },
        workspace: {
          id: "ws-ana",
          dbUrl: "libsql://wl-ana.turso.io",
          dbAuthToken: "scoped-ana",
        },
      },
    });
    expect(result).toEqual({
      kind: "authenticated",
      workspaceId: "ws-ana",
      dbUrl: "libsql://wl-ana.turso.io",
      token: "scoped-ana",
    });
  });

  test("falls back to the group token when a legacy session omits the per-workspace JWT (#1185)", () => {
    const result = resolveStoreTarget({
      env: {
        AUTH_GOOGLE_ID: "google-id",
        AUTH_GOOGLE_SECRET: "google-secret",
        WORTHLINE_DB_AUTH_TOKEN: "group-token",
      },
      session: {
        user: { email: "ana@example.com" },
        workspace: { id: "ws-ana", dbUrl: "libsql://wl-ana.turso.io" },
      },
    });
    expect(result).toEqual({
      kind: "authenticated",
      workspaceId: "ws-ana",
      dbUrl: "libsql://wl-ana.turso.io",
      token: "group-token",
    });
  });

  test("returns unauthenticated when signed in but no workspace is resolved yet", () => {
    const result = resolveStoreTarget({
      env: {
        AUTH_GOOGLE_ID: "google-id",
        AUTH_GOOGLE_SECRET: "google-secret",
      },
      session: { user: { email: "ana@example.com" } },
    });
    expect(result).toEqual({ kind: "unauthenticated" });
  });

  test("returns demo when logged out and a persona cookie is present (auth configured)", () => {
    const result = resolveStoreTarget({
      env: {
        AUTH_GOOGLE_ID: "google-id",
        AUTH_GOOGLE_SECRET: "google-secret",
      },
      session: null,
      personaCookie: "inversor",
    });
    // `now` is empty so the demo clock falls back to the real date — the demo is
    // no longer pinned by an env var (it seeds relative to "now").
    expect(result).toEqual({ kind: "demo", persona: "inversor", now: "" });
  });

  test("authentication wins over a stale persona cookie", () => {
    const result = resolveStoreTarget({
      env: {
        AUTH_GOOGLE_ID: "google-id",
        AUTH_GOOGLE_SECRET: "google-secret",
        WORTHLINE_DB_AUTH_TOKEN: "group-token",
      },
      session: {
        user: { email: "ana@example.com" },
        workspace: { id: "ws-ana", dbUrl: "libsql://wl-ana.turso.io" },
      },
      personaCookie: "familia",
    });
    expect(result).toEqual({
      kind: "authenticated",
      workspaceId: "ws-ana",
      dbUrl: "libsql://wl-ana.turso.io",
      token: "group-token",
    });
  });

  test("returns authenticated from an MCP token's workspace claims (token-derived source)", () => {
    const result = resolveStoreTarget({
      env: {
        AUTH_GOOGLE_ID: "google-id",
        AUTH_GOOGLE_SECRET: "google-secret",
        WORTHLINE_DB_AUTH_TOKEN: "group-token",
      },
      session: null,
      mcpWorkspace: {
        workspaceId: "ws-ana",
        dbUrl: "libsql://wl-ana.turso.io",
        dbAuthToken: "scoped-mcp",
      },
    });
    expect(result).toEqual({
      kind: "authenticated",
      workspaceId: "ws-ana",
      dbUrl: "libsql://wl-ana.turso.io",
      token: "scoped-mcp",
    });
  });

  test("an MCP token's workspace wins over a stale persona cookie", () => {
    const result = resolveStoreTarget({
      env: {
        AUTH_GOOGLE_ID: "google-id",
        AUTH_GOOGLE_SECRET: "google-secret",
        WORTHLINE_DB_AUTH_TOKEN: "group-token",
      },
      session: null,
      personaCookie: "familia",
      mcpWorkspace: { workspaceId: "ws-ana", dbUrl: "libsql://wl-ana.turso.io" },
    });
    expect(result).toEqual({
      kind: "authenticated",
      workspaceId: "ws-ana",
      dbUrl: "libsql://wl-ana.turso.io",
      token: "group-token",
    });
  });

  test("a persona cookie opens the demo even in local no-auth mode (dev preview)", () => {
    const result = resolveStoreTarget({
      env: {},
      session: null,
      personaCookie: "familia",
    });
    expect(result).toEqual({ kind: "demo", persona: "familia", now: "" });
  });

  test("an unknown persona cookie falls back to the default persona", () => {
    const result = resolveStoreTarget({
      env: { AUTH_GOOGLE_ID: "id", AUTH_GOOGLE_SECRET: "secret" },
      session: null,
      personaCookie: "ghost",
    });
    expect(result).toEqual({ kind: "demo", persona: "familia", now: "" });
  });

  test("an empty persona cookie is treated as absent", () => {
    const result = resolveStoreTarget({
      env: { AUTH_GOOGLE_ID: "id", AUTH_GOOGLE_SECRET: "secret" },
      session: null,
      personaCookie: "",
    });
    expect(result).toEqual({ kind: "unauthenticated" });
  });

  // === Admin impersonation (#697, ADR 0030) ===

  const ADMIN_ENV = {
    AUTH_GOOGLE_ID: "google-id",
    AUTH_GOOGLE_SECRET: "google-secret",
    WORTHLINE_ADMIN_EMAIL: "admin@example.com",
    WORTHLINE_DB_AUTH_TOKEN: "group-token",
  };

  test("an admin session with a resolved impersonation target opens the impersonated workspace", () => {
    const result = resolveStoreTarget({
      env: ADMIN_ENV,
      session: {
        user: { email: "admin@example.com" },
        workspace: { id: "ws-admin", dbUrl: "libsql://wl-admin.turso.io" },
      },
      impersonateWorkspace: {
        workspaceId: "ws-target",
        dbUrl: "libsql://wl-target.turso.io",
        email: "target@example.com",
        dbAuthToken: "scoped-target",
      },
    });
    expect(result).toEqual({
      kind: "authenticated",
      workspaceId: "ws-target",
      dbUrl: "libsql://wl-target.turso.io",
      token: "scoped-target",
      impersonatedEmail: "target@example.com",
    });
  });

  test("a padded/mis-cased WORTHLINE_ADMIN_EMAIL still matches the session — a deploy typo must not lock out the admin", () => {
    const result = resolveStoreTarget({
      env: { ...ADMIN_ENV, WORTHLINE_ADMIN_EMAIL: "  JenArvaezg@GMAIL.com  " },
      session: {
        user: { email: "jenarvaezg@gmail.com" },
        workspace: { id: "ws-admin", dbUrl: "libsql://wl-admin.turso.io" },
      },
      impersonateWorkspace: {
        workspaceId: "ws-target",
        dbUrl: "libsql://wl-target.turso.io",
        email: "target@example.com",
      },
    });
    expect(result).toEqual({
      kind: "authenticated",
      workspaceId: "ws-target",
      dbUrl: "libsql://wl-target.turso.io",
      token: "group-token",
      impersonatedEmail: "target@example.com",
    });
  });

  test("a non-admin session with a resolved impersonation target still opens its OWN workspace — the cookie alone grants nothing", () => {
    const result = resolveStoreTarget({
      env: ADMIN_ENV,
      session: {
        user: { email: "ana@example.com" },
        workspace: { id: "ws-ana", dbUrl: "libsql://wl-ana.turso.io" },
      },
      // As if a non-admin visitor hand-crafted the wl_impersonate cookie and
      // it were (incorrectly) resolved anyway — resolveStoreTarget is the
      // last line of defense and must still refuse it.
      impersonateWorkspace: {
        workspaceId: "ws-target",
        dbUrl: "libsql://wl-target.turso.io",
        email: "target@example.com",
      },
    });
    expect(result).toEqual({
      kind: "authenticated",
      workspaceId: "ws-ana",
      dbUrl: "libsql://wl-ana.turso.io",
      token: "group-token",
    });
  });

  test("no session with a resolved impersonation target resolves as unauthenticated, not the impersonated workspace", () => {
    const result = resolveStoreTarget({
      env: ADMIN_ENV,
      session: null,
      impersonateWorkspace: {
        workspaceId: "ws-target",
        dbUrl: "libsql://wl-target.turso.io",
        email: "target@example.com",
      },
    });
    expect(result).toEqual({ kind: "unauthenticated" });
  });

  test("an admin session without WORTHLINE_ADMIN_EMAIL configured never impersonates, even with a target resolved", () => {
    const envWithoutAdmin = {
      AUTH_GOOGLE_ID: ADMIN_ENV.AUTH_GOOGLE_ID,
      AUTH_GOOGLE_SECRET: ADMIN_ENV.AUTH_GOOGLE_SECRET,
      WORTHLINE_DB_AUTH_TOKEN: ADMIN_ENV.WORTHLINE_DB_AUTH_TOKEN,
    };
    const result = resolveStoreTarget({
      env: envWithoutAdmin,
      session: {
        user: { email: "admin@example.com" },
        workspace: { id: "ws-admin", dbUrl: "libsql://wl-admin.turso.io" },
      },
      impersonateWorkspace: {
        workspaceId: "ws-target",
        dbUrl: "libsql://wl-target.turso.io",
        email: "target@example.com",
      },
    });
    expect(result).toEqual({
      kind: "authenticated",
      workspaceId: "ws-admin",
      dbUrl: "libsql://wl-admin.turso.io",
      token: "group-token",
    });
  });

  test("an admin session with no impersonation target opens the admin's own workspace as usual", () => {
    const result = resolveStoreTarget({
      env: ADMIN_ENV,
      session: {
        user: { email: "admin@example.com" },
        workspace: { id: "ws-admin", dbUrl: "libsql://wl-admin.turso.io" },
      },
      impersonateWorkspace: null,
    });
    expect(result).toEqual({
      kind: "authenticated",
      workspaceId: "ws-admin",
      dbUrl: "libsql://wl-admin.turso.io",
      token: "group-token",
    });
  });

  test("an MCP request never carries an impersonation target, admin session or not", () => {
    // storeTargetFromMcpAuth never sets impersonateWorkspace — this asserts
    // the resolver's own behavior when it is genuinely absent, mirroring the
    // MCP call shape (session: null, mcpWorkspace set).
    const result = resolveStoreTarget({
      env: ADMIN_ENV,
      session: null,
      mcpWorkspace: { workspaceId: "ws-mcp", dbUrl: "libsql://wl-mcp.turso.io" },
    });
    expect(result).toEqual({
      kind: "authenticated",
      workspaceId: "ws-mcp",
      dbUrl: "libsql://wl-mcp.turso.io",
      token: "group-token",
    });
  });
});

/**
 * The viewer session (#1843, ADR 0112). `viewedWorkspace` is what the
 * `wl_viewing` cookie resolved to through `readViewerAccess` for THIS session's
 * email — or nothing. The resolver re-checks that the access belongs to the
 * session it is resolving, never trusting the caller to have done so.
 */
describe("resolveStoreTarget · viewer", () => {
  const ENV = {
    AUTH_GOOGLE_ID: "google-id",
    AUTH_GOOGLE_SECRET: "google-secret",
    WORTHLINE_ADMIN_EMAIL: "admin@example.com",
    WORTHLINE_DB_AUTH_TOKEN: "group-token",
  };

  const LUCIA_SESSION = {
    user: { email: "lucia@example.com" },
    workspace: {
      id: "ws-lucia",
      dbUrl: "libsql://wl-lucia.turso.io",
      dbAuthToken: "full-lucia",
    },
  };

  const OWN_LUCIA = {
    kind: "authenticated",
    workspaceId: "ws-lucia",
    dbUrl: "libsql://wl-lucia.turso.io",
    token: "full-lucia",
  } as const;

  const JORGE_FOR_LUCIA = {
    workspaceId: "ws-jorge",
    dbUrl: "libsql://wl-jorge.turso.io",
    readOnlyToken: "read-only-jorge",
    ownerEmail: "jorge@example.com",
    viewerEmail: "lucia@example.com",
  };

  test("a session with its own viewer grant opens the shared workspace with the read-only token", () => {
    expect(
      resolveStoreTarget({
        env: ENV,
        session: LUCIA_SESSION,
        viewedWorkspace: JORGE_FOR_LUCIA,
      }),
    ).toEqual({
      kind: "authenticated",
      workspaceId: "ws-jorge",
      dbUrl: "libsql://wl-jorge.turso.io",
      token: "read-only-jorge",
      sharedByEmail: "jorge@example.com",
    });
  });

  test("the session email is compared trimmed and case-insensitively", () => {
    const result = resolveStoreTarget({
      env: ENV,
      session: { ...LUCIA_SESSION, user: { email: " Lucia@Example.com " } },
      viewedWorkspace: { ...JORGE_FOR_LUCIA, viewerEmail: "LUCIA@example.com" },
    });
    expect(result).toMatchObject({ sharedByEmail: "jorge@example.com" });
  });

  test("no access resolved (forged cookie, revoked grant) opens the session's own workspace", () => {
    expect(
      resolveStoreTarget({ env: ENV, session: LUCIA_SESSION, viewedWorkspace: null }),
    ).toEqual(OWN_LUCIA);
  });

  test("an access that belongs to another email is ignored — the session's own workspace", () => {
    expect(
      resolveStoreTarget({
        env: ENV,
        session: LUCIA_SESSION,
        viewedWorkspace: { ...JORGE_FOR_LUCIA, viewerEmail: "mallory@example.com" },
      }),
    ).toEqual(OWN_LUCIA);
  });

  test("an access without a read-only token is ignored — never the group token", () => {
    expect(
      resolveStoreTarget({
        env: ENV,
        session: LUCIA_SESSION,
        viewedWorkspace: { ...JORGE_FOR_LUCIA, readOnlyToken: "" },
      }),
    ).toEqual(OWN_LUCIA);
  });

  test("no session with an access resolves as unauthenticated", () => {
    expect(
      resolveStoreTarget({ env: ENV, session: null, viewedWorkspace: JORGE_FOR_LUCIA }),
    ).toEqual({ kind: "unauthenticated" });
  });

  test("a demo persona with an access stays the demo", () => {
    expect(
      resolveStoreTarget({
        env: ENV,
        session: null,
        personaCookie: "familia",
        viewedWorkspace: JORGE_FOR_LUCIA,
      }),
    ).toEqual({ kind: "demo", persona: "familia", now: "" });
  });

  test("an admin with both cookies impersonates — impersonation outranks the viewer", () => {
    const result = resolveStoreTarget({
      env: ENV,
      session: {
        user: { email: "admin@example.com" },
        workspace: { id: "ws-admin", dbUrl: "libsql://wl-admin.turso.io" },
      },
      impersonateWorkspace: {
        workspaceId: "ws-target",
        dbUrl: "libsql://wl-target.turso.io",
        email: "target@example.com",
        dbAuthToken: "full-target",
      },
      viewedWorkspace: { ...JORGE_FOR_LUCIA, viewerEmail: "admin@example.com" },
    });
    expect(result).toEqual({
      kind: "authenticated",
      workspaceId: "ws-target",
      dbUrl: "libsql://wl-target.turso.io",
      token: "full-target",
      impersonatedEmail: "target@example.com",
    });
  });

  test("an admin viewing a workspace shared with them (no impersonation) is a viewer", () => {
    const result = resolveStoreTarget({
      env: ENV,
      session: { user: { email: "admin@example.com" } },
      viewedWorkspace: { ...JORGE_FOR_LUCIA, viewerEmail: "admin@example.com" },
    });
    expect(result).toMatchObject({
      sharedByEmail: "jorge@example.com",
      token: "read-only-jorge",
    });
  });
});
