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
});
