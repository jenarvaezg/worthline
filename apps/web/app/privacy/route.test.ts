import { PRIVACY_COOKIE_NAME } from "@web/intake";
import { type NextRequest } from "next/server";
import { describe, expect, test, vi } from "vitest";

import { POST } from "./route";

let mockPrivacyCookie: string | undefined;
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === PRIVACY_COOKIE_NAME && mockPrivacyCookie
        ? { value: mockPrivacyCookie }
        : undefined,
  }),
}));

function privacyRequest(returnTo: string): ReturnType<typeof POST> {
  const body = new FormData();
  body.set("returnTo", returnTo);

  return POST(
    new Request("http://localhost:3000/privacy", {
      body,
      method: "POST",
    }) as NextRequest,
  );
}

describe("POST /privacy", () => {
  test("turns privacy mode on and redirects back", async () => {
    mockPrivacyCookie = undefined;
    const response = await privacyRequest("/historico");

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("http://localhost:3000/historico");
    expect(response.cookies.get(PRIVACY_COOKIE_NAME)?.value).toBe("1");
  });

  test("turns privacy mode off when it was already on", async () => {
    mockPrivacyCookie = "1";
    const response = await privacyRequest("/");

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("http://localhost:3000/");
    expect(response.cookies.get(PRIVACY_COOKIE_NAME)?.value).toBe("");
  });

  test("falls back to root when returnTo is not a local path", async () => {
    mockPrivacyCookie = undefined;
    const response = await privacyRequest("https://evil.example.com/");

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("http://localhost:3000/");
  });
});
