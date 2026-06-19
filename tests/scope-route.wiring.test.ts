/**
 * Wiring suite: POST /scope.
 *
 * Scope switching is a native form POST. The route writes the durable
 * `wl_scope` cookie and redirects back with a `scope=` query override so the
 * very next render highlights the selected tab even before later cookie-only
 * navigations.
 */

import { NextRequest } from "next/server";
import { describe, expect, test } from "vitest";

import { POST } from "@web/scope/route";

function request(fields: Record<string, string>): NextRequest {
  const body = new FormData();

  for (const [key, value] of Object.entries(fields)) {
    body.set(key, value);
  }

  return new NextRequest("http://worthline.local/scope", {
    body,
    method: "POST",
  });
}

describe("POST /scope", () => {
  test("sets the scope cookie and redirects back with an explicit scope override", async () => {
    const response = await POST(
      request({ returnTo: "/patrimonio", scopeId: "member_jose" }),
    );

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      "http://worthline.local/patrimonio?scope=member_jose",
    );
    expect(response.headers.get("set-cookie")).toContain("wl_scope=member_jose");
    expect(response.headers.get("set-cookie")).toContain("HttpOnly");
  });

  test("replaces an existing scope override in the return URL", async () => {
    const response = await POST(
      request({
        returnTo: "/?scope=household&view=liquid",
        scopeId: "member_ana",
      }),
    );

    expect(response.headers.get("location")).toBe(
      "http://worthline.local/?scope=member_ana&view=liquid",
    );
  });

  test("blank scopeId redirects without setting a cookie", async () => {
    const response = await POST(request({ returnTo: "/inversiones", scopeId: "" }));

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("http://worthline.local/inversiones");
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  test("unsafe returnTo cannot redirect off-site", async () => {
    const response = await POST(
      request({ returnTo: "//evil.com/steal", scopeId: "member_ana" }),
    );

    expect(response.headers.get("location")).toBe(
      "http://worthline.local/?scope=member_ana",
    );
  });
});
