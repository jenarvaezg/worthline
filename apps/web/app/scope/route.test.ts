/**
 * Regression tests for the scope-switch POST (#1179). The redirect after a
 * native form POST is re-checked by the browser against CSP `form-action
 * 'self'`; an absolute Location built off `request.url` can carry a host
 * (`localhost`) that differs from the browser's (`127.0.0.1`), which reads as a
 * cross-origin hop and logs a CSP violation (it failed the e2e scope journeys).
 * The contract here: the Location is RELATIVE, so the browser resolves it
 * against its own origin.
 */

import { NextRequest } from "next/server";
import { describe, expect, test } from "vitest";

import { POST } from "./route";

function scopePost(body: string): NextRequest {
  return new NextRequest("http://127.0.0.1:3001/scope", {
    body,
    headers: { "content-type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
}

describe("POST /scope", () => {
  test("303-redirects to a RELATIVE scoped returnTo and sets the scope cookie", async () => {
    const response = await POST(scopePost("scopeId=wl_scp_x&returnTo=/patrimonio"));

    expect(response.status).toBe(303);
    // Relative, never absolute: an absolute URL can carry a host that differs
    // from the browser's and trip CSP form-action 'self' on the redirect hop.
    expect(response.headers.get("location")).toBe("/patrimonio?scope=wl_scp_x");
    expect(response.cookies.get("wl_scope")?.value).toBe("wl_scp_x");
  });

  test("falls back to /app and rejects an absolute returnTo (open redirect)", async () => {
    const response = await POST(
      scopePost("scopeId=wl_scp_x&returnTo=https://evil.example"),
    );

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/app?scope=wl_scp_x");
  });

  test("without a scopeId it redirects without touching the cookie", async () => {
    const response = await POST(scopePost("returnTo=/app"));

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/app");
    expect(response.cookies.get("wl_scope")).toBeUndefined();
  });
});
