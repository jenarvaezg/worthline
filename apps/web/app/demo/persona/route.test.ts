import { DEMO_PERSONA_COOKIE_NAME } from "@web/demo/demo-context";
import { SCOPE_COOKIE_NAME } from "@web/intake";
import { NextRequest } from "next/server";
import { describe, expect, test } from "vitest";

import { GET, POST } from "./route";

describe("/demo/persona", () => {
  test("GET sets the persona cookie and redirects to /app", () => {
    const response = GET(
      new NextRequest("http://worthline.local/demo/persona?persona=familia"),
    );

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/app");
    expect(response.cookies.get(DEMO_PERSONA_COOKIE_NAME)?.value).toBe("familia");
    expect(response.cookies.get(SCOPE_COOKIE_NAME)?.value).toBe("");
  });

  test("POST sets the persona cookie and redirects to /app", async () => {
    const body = new FormData();
    body.set("persona", "inversor");

    const response = await POST(
      new NextRequest("http://worthline.local/demo/persona", {
        body,
        method: "POST",
      }),
    );

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/app");
    expect(response.cookies.get(DEMO_PERSONA_COOKIE_NAME)?.value).toBe("inversor");
    expect(response.cookies.get(SCOPE_COOKIE_NAME)?.value).toBe("");
  });

  test("unknown persona falls back to familia", () => {
    const response = GET(
      new NextRequest("http://worthline.local/demo/persona?persona=unknown"),
    );

    expect(response.cookies.get(DEMO_PERSONA_COOKIE_NAME)?.value).toBe("familia");
  });
});
