/**
 * `guardAdmin` tests (#697, ADR 0030): the admin session must match
 * WORTHLINE_ADMIN_EMAIL exactly, or the request 404s — identically to any
 * unknown URL — for a different user, no session, an unset env var, local
 * no-auth mode, and the demo (which never carries a real session).
 */
import { afterEach, describe, expect, it, vi } from "vitest";

type FakeSession = { user?: { email?: string | null } } | null;

let mockSession: FakeSession = null;
let mockPersonaCookie: string | undefined;

vi.mock("@web/auth", () => ({
  auth: async (): Promise<FakeSession> => mockSession,
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === "wl_demo_persona" && mockPersonaCookie
        ? { value: mockPersonaCookie }
        : undefined,
  }),
}));

import { guardAdmin } from "@web/admin/guard-admin";

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  mockSession = null;
  mockPersonaCookie = undefined;
});

const NOT_FOUND_DIGEST = "NEXT_HTTP_ERROR_FALLBACK;404";

/** Run guardAdmin expecting it to call notFound(); true iff it did. */
async function calledNotFound(run: () => Promise<unknown>): Promise<boolean> {
  try {
    await run();
    return false;
  } catch (err) {
    return (err as { digest?: string })?.digest === NOT_FOUND_DIGEST;
  }
}

describe("guardAdmin", () => {
  it("passes for the admin session and returns its email", async () => {
    process.env.WORTHLINE_ADMIN_EMAIL = "admin@example.com";
    process.env.AUTH_GOOGLE_ID = "google-id";
    process.env.AUTH_GOOGLE_SECRET = "google-secret";
    mockSession = { user: { email: "admin@example.com" } };

    await expect(guardAdmin()).resolves.toEqual({ email: "admin@example.com" });
  });

  it("404s for a different signed-in user", async () => {
    process.env.WORTHLINE_ADMIN_EMAIL = "admin@example.com";
    process.env.AUTH_GOOGLE_ID = "google-id";
    process.env.AUTH_GOOGLE_SECRET = "google-secret";
    mockSession = { user: { email: "someone-else@example.com" } };

    expect(await calledNotFound(() => guardAdmin())).toBe(true);
  });

  it("404s when logged out (no session)", async () => {
    process.env.WORTHLINE_ADMIN_EMAIL = "admin@example.com";
    process.env.AUTH_GOOGLE_ID = "google-id";
    process.env.AUTH_GOOGLE_SECRET = "google-secret";
    mockSession = null;

    expect(await calledNotFound(() => guardAdmin())).toBe(true);
  });

  it("404s when WORTHLINE_ADMIN_EMAIL is unset, even for what would otherwise match", async () => {
    delete process.env.WORTHLINE_ADMIN_EMAIL;
    process.env.AUTH_GOOGLE_ID = "google-id";
    process.env.AUTH_GOOGLE_SECRET = "google-secret";
    mockSession = { user: { email: "admin@example.com" } };

    expect(await calledNotFound(() => guardAdmin())).toBe(true);
  });

  it("404s in local no-auth mode, where there is no session mechanism at all", async () => {
    process.env.WORTHLINE_ADMIN_EMAIL = "admin@example.com";
    delete process.env.AUTH_GOOGLE_ID;
    delete process.env.AUTH_GOOGLE_SECRET;

    expect(await calledNotFound(() => guardAdmin())).toBe(true);
  });

  it("404s for a demo request (logged out, persona cookie set) — never confused with a real session", async () => {
    process.env.WORTHLINE_ADMIN_EMAIL = "admin@example.com";
    process.env.AUTH_GOOGLE_ID = "google-id";
    process.env.AUTH_GOOGLE_SECRET = "google-secret";
    mockSession = null;
    mockPersonaCookie = "familia";

    expect(await calledNotFound(() => guardAdmin())).toBe(true);
  });
});
