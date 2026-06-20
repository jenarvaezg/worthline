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

  test("returns authenticated with the env-configured workspace when there is a session", () => {
    const result = resolveStoreTarget({
      env: {
        AUTH_GOOGLE_ID: "google-id",
        AUTH_GOOGLE_SECRET: "google-secret",
        WORTHLINE_DB_AUTH_TOKEN: "group-token",
        WORTHLINE_DB_URL: "libsql://workspace.turso.io",
      },
      session: { user: { email: "user@example.com" } },
    });
    expect(result).toEqual({
      kind: "authenticated",
      workspaceId: "default",
      dbUrl: "libsql://workspace.turso.io",
      token: "group-token",
    });
  });
});
