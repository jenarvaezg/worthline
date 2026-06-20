import { describe, expect, test } from "vitest";

import { shouldRedirectToLogin } from "./auth-gate";

describe("shouldRedirectToLogin", () => {
  test("never redirects when auth is not configured (local no-auth mode)", () => {
    expect(
      shouldRedirectToLogin({
        authConfigured: false,
        hasSession: false,
        pathname: "/patrimonio",
      }),
    ).toBe(false);
  });

  test("does not redirect an authenticated request", () => {
    expect(
      shouldRedirectToLogin({
        authConfigured: true,
        hasSession: true,
        pathname: "/patrimonio",
      }),
    ).toBe(false);
  });

  test("redirects an unauthenticated request to a real page", () => {
    expect(
      shouldRedirectToLogin({
        authConfigured: true,
        hasSession: false,
        pathname: "/patrimonio",
      }),
    ).toBe(true);
  });

  test("never redirects the public paths (/login, /api/auth/*)", () => {
    for (const pathname of ["/login", "/api/auth/signin", "/api/auth/callback/google"]) {
      expect(
        shouldRedirectToLogin({
          authConfigured: true,
          hasSession: false,
          pathname,
        }),
      ).toBe(false);
    }
  });
});
