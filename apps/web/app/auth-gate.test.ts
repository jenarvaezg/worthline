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

  test("redirects an unauthenticated request to a gated page", () => {
    expect(
      shouldRedirectToLogin({
        authConfigured: true,
        hasSession: false,
        pathname: "/app",
      }),
    ).toBe(true);
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

  test("never redirects the public paths (/login, /, /demo, /api/auth/*, /mcp-icon.svg)", () => {
    for (const pathname of [
      "/",
      "/login",
      "/demo",
      "/demo/persona",
      "/api/auth/signin",
      "/api/auth/callback/google",
      "/mcp-icon.svg",
    ]) {
      expect(
        shouldRedirectToLogin({
          authConfigured: true,
          hasSession: false,
          hasPersonaCookie: false,
          pathname,
        }),
      ).toBe(false);
    }
  });

  test("never redirects PWA public assets behind the sign-in wall", () => {
    for (const pathname of ["/manifest.json", "/sw.js", "/mcp-icon.svg"]) {
      expect(
        shouldRedirectToLogin({
          authConfigured: true,
          hasSession: false,
          hasPersonaCookie: false,
          pathname,
        }),
      ).toBe(false);
    }
  });

  test("never redirects the daily-snapshot cron (it carries a CRON_SECRET bearer, not a session)", () => {
    expect(
      shouldRedirectToLogin({
        authConfigured: true,
        hasSession: false,
        hasPersonaCookie: false,
        pathname: "/api/cron/snapshot",
      }),
    ).toBe(false);
  });

  test("never redirects the MCP OAuth discovery paths (the Auth.js redirect would swallow the handshake)", () => {
    for (const pathname of ["/api/mcp", "/.well-known/oauth-protected-resource"]) {
      expect(
        shouldRedirectToLogin({
          authConfigured: true,
          hasSession: false,
          hasPersonaCookie: false,
          pathname,
        }),
      ).toBe(false);
    }
  });

  test("does not redirect a logged-out demo request (persona cookie present)", () => {
    expect(
      shouldRedirectToLogin({
        authConfigured: true,
        hasSession: false,
        hasPersonaCookie: true,
        pathname: "/patrimonio",
      }),
    ).toBe(false);
  });
});
