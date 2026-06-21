import { afterEach, describe, expect, test } from "vitest";

import { GET, OPTIONS } from "./route";

const RESOURCE_URL = "https://worthline.example/.well-known/oauth-protected-resource";

const originalAuthServer = process.env.WORTHLINE_MCP_AUTH_SERVER_URL;

afterEach(() => {
  if (originalAuthServer === undefined) {
    delete process.env.WORTHLINE_MCP_AUTH_SERVER_URL;
  } else {
    process.env.WORTHLINE_MCP_AUTH_SERVER_URL = originalAuthServer;
  }
});

describe("GET /.well-known/oauth-protected-resource", () => {
  test("serves RFC 9728 metadata: public origin as resource + the configured authorization server", async () => {
    process.env.WORTHLINE_MCP_AUTH_SERVER_URL = "https://auth.example/oauth";

    const res = GET(new Request(RESOURCE_URL));

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");

    const body = (await res.json()) as {
      resource: string;
      authorization_servers: string[];
    };
    // The resource identifier is worthline's public origin, never an internal
    // URL — here derived from the request (no proxy headers in the test).
    expect(body.resource).toBe("https://worthline.example");
    expect(body.authorization_servers).toContain("https://auth.example/oauth");
  });

  test("derives the public origin from proxy headers (Vercel), not the internal request URL", async () => {
    const res = GET(
      new Request("http://10.0.0.1/.well-known/oauth-protected-resource", {
        headers: {
          "x-forwarded-host": "worthline-web.vercel.app",
          "x-forwarded-proto": "https",
        },
      }),
    );

    const body = (await res.json()) as { resource: string };
    expect(body.resource).toBe("https://worthline-web.vercel.app");
  });

  test("falls back to a non-resolving placeholder authorization server until WorkOS is wired (S4)", async () => {
    delete process.env.WORTHLINE_MCP_AUTH_SERVER_URL;

    const res = GET(new Request(RESOURCE_URL));

    const body = (await res.json()) as { authorization_servers: string[] };
    // A real, parseable metadata document (kills "Failed to parse JSON") whose
    // AS is a `.invalid` host that never resolves — the client fails cleanly
    // rather than reaching an unintended server before S4 configures WorkOS.
    expect(body.authorization_servers).toContain(
      "https://authorization-server.invalid/oauth",
    );
  });
});

describe("OPTIONS /.well-known/oauth-protected-resource", () => {
  test("answers the CORS preflight browser MCP clients (claude.ai) need", () => {
    const res = OPTIONS();

    expect(res.status).toBeLessThan(400);
    // claude.ai runs in a browser: the preflight must allow any origin and the
    // GET the client then makes to read the metadata.
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("access-control-allow-methods")).toContain("GET");
  });
});
