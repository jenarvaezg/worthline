/**
 * Privacy-toggle POST: cookie toggle + RELATIVE-Location redirect (#1179). The
 * redirect after a native form POST is re-checked by the browser against CSP
 * `form-action 'self'`; an absolute Location built off `request.url` can carry
 * a host (`localhost`) that differs from the browser's (`127.0.0.1`), which
 * reads as a cross-origin hop and logs a CSP violation (it failed the e2e
 * scope journeys). A relative Location resolves against the browser's origin.
 */

import { PRIVACY_COOKIE_NAME } from "@web/intake";
import { NextRequest } from "next/server";
import { describe, expect, test } from "vitest";

import { POST } from "./route";

function privacyRequest(returnTo: string, cookie?: string): ReturnType<typeof POST> {
  const body = new URLSearchParams({ returnTo });

  return POST(
    new NextRequest("http://127.0.0.1:3001/privacy", {
      body,
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        ...(cookie ? { cookie } : {}),
      },
      method: "POST",
    }),
  );
}

describe("POST /privacy", () => {
  test("turns privacy mode on and redirects back with a RELATIVE location", async () => {
    const response = await privacyRequest("/historico");

    expect(response.status).toBe(303);
    // Relative, never absolute: an absolute URL can carry a host that differs
    // from the browser's and trip CSP form-action 'self' on the redirect hop.
    expect(response.headers.get("location")).toBe("/historico");
    expect(response.cookies.get(PRIVACY_COOKIE_NAME)?.value).toBe("1");
  });

  test("turns privacy mode off when it was already on", async () => {
    const response = await privacyRequest("/", `${PRIVACY_COOKIE_NAME}=1`);

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/");
    // Deleting sets an expired empty cookie on the response.
    expect(response.cookies.get(PRIVACY_COOKIE_NAME)?.value).toBe("");
  });

  test("falls back to /app when returnTo is not a local path", async () => {
    const response = await privacyRequest("https://evil.example.com/");

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/app");
  });
});
