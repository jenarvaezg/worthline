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
        WORTHLINE_DEMO_NOW: "2026-06-20",
      },
      session: null,
      personaCookie: "inversor",
    });
    expect(result).toEqual({ kind: "demo", persona: "inversor", now: "2026-06-20" });
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
      mcpWorkspace: { workspaceId: "ws-ana", dbUrl: "libsql://wl-ana.turso.io" },
    });
    expect(result).toEqual({
      kind: "authenticated",
      workspaceId: "ws-ana",
      dbUrl: "libsql://wl-ana.turso.io",
      token: "group-token",
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
});
