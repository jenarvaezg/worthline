import { afterEach, describe, expect, test } from "vitest";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";

import { storeTargetFromMcpAuth } from "./mcp-store-target";

const originalGroupToken = process.env.WORTHLINE_DB_AUTH_TOKEN;

afterEach(() => {
  if (originalGroupToken === undefined) delete process.env.WORTHLINE_DB_AUTH_TOKEN;
  else process.env.WORTHLINE_DB_AUTH_TOKEN = originalGroupToken;
});

function authInfo(extra: Record<string, unknown> | undefined): AuthInfo {
  return {
    token: "oauth-access-token",
    clientId: "workos_user",
    scopes: ["worthline:read"],
    ...(extra === undefined ? {} : { extra }),
  };
}

describe("storeTargetFromMcpAuth", () => {
  test("no token ⇒ undefined (the demo/local path resolves itself)", () => {
    expect(storeTargetFromMcpAuth(undefined)).toBeUndefined();
  });

  test("a token's workspace claims ⇒ the authenticated target (group token from env)", () => {
    process.env.WORTHLINE_DB_AUTH_TOKEN = "group-token";
    const target = storeTargetFromMcpAuth(
      authInfo({ workspaceId: "ws-ana", dbUrl: "libsql://wl-ana.turso.io" }),
    );
    expect(target).toEqual({
      kind: "authenticated",
      workspaceId: "ws-ana",
      dbUrl: "libsql://wl-ana.turso.io",
      token: "group-token",
    });
  });

  test("a verified token with malformed/absent workspace claims fails loud (never degrades to stub)", () => {
    // A verified token MUST carry usable claims; if it doesn't, that's a verifier
    // / control-plane fault we surface rather than silently serving demo data.
    expect(() => storeTargetFromMcpAuth(authInfo(undefined))).toThrow();
    expect(() => storeTargetFromMcpAuth(authInfo({ workspaceId: "ws-ana" }))).toThrow();
    expect(() =>
      storeTargetFromMcpAuth(authInfo({ workspaceId: 42, dbUrl: "libsql://x" })),
    ).toThrow();
  });
});
