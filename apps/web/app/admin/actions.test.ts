/**
 * Admin action tests (#697, ADR 0030): every admin action re-verifies
 * `guardAdmin` as its first line — called directly with no admin session, it
 * must reject (404) exactly like the page, never touching the cookie. With an
 * admin session, impersonate sets the cookie and redirects home; stop clears
 * it and redirects to /admin.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

type FakeSession = { user?: { email?: string | null } } | null;
type CookieOptions = {
  httpOnly?: boolean;
  maxAge?: number;
  path?: string;
  sameSite?: string;
};

let mockSession: FakeSession = null;
const cookieJar = new Map<string, { value: string; options?: CookieOptions }>();

vi.mock("@web/auth", () => ({
  auth: async (): Promise<FakeSession> => mockSession,
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => cookieJar.get(name),
    set: (name: string, value: string, options?: CookieOptions) => {
      cookieJar.set(name, options ? { value, options } : { value });
    },
    delete: (name: string) => {
      cookieJar.delete(name);
    },
  }),
}));

import { impersonateWorkspaceAction, stopImpersonationAction } from "@web/admin/actions";
import { IMPERSONATE_COOKIE_NAME } from "@web/admin/impersonate-cookie";

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  mockSession = null;
  cookieJar.clear();
});

function asAdmin(): void {
  process.env.WORTHLINE_ADMIN_EMAIL = "admin@example.com";
  process.env.AUTH_GOOGLE_ID = "google-id";
  process.env.AUTH_GOOGLE_SECRET = "google-secret";
  mockSession = { user: { email: "admin@example.com" } };
}

function asNonAdmin(): void {
  process.env.WORTHLINE_ADMIN_EMAIL = "admin@example.com";
  process.env.AUTH_GOOGLE_ID = "google-id";
  process.env.AUTH_GOOGLE_SECRET = "google-secret";
  mockSession = { user: { email: "someone-else@example.com" } };
}

/** Run an action expecting redirect(); returns the destination digest. */
async function redirectOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
    throw new Error("action did not redirect");
  } catch (err) {
    const e = err as { message?: string; digest?: string };
    if (e.message === "NEXT_REDIRECT" && typeof e.digest === "string") {
      return e.digest;
    }
    throw err;
  }
}

describe("impersonateWorkspaceAction", () => {
  it("rejects (404) for a non-admin session and never touches the cookie", async () => {
    asNonAdmin();
    const fd = new FormData();
    fd.set("workspaceId", "ws-target");

    await expect(impersonateWorkspaceAction(fd)).rejects.toMatchObject({
      digest: "NEXT_HTTP_ERROR_FALLBACK;404",
    });
    expect(cookieJar.has(IMPERSONATE_COOKIE_NAME)).toBe(false);
  });

  it("sets the httpOnly impersonation cookie and redirects home for the admin", async () => {
    asAdmin();
    const fd = new FormData();
    fd.set("workspaceId", "ws-target");

    const digest = await redirectOf(() => impersonateWorkspaceAction(fd));
    expect(digest).toContain("/;"); // NEXT_REDIRECT digest embeds the destination

    const cookie = cookieJar.get(IMPERSONATE_COOKIE_NAME);
    expect(cookie?.value).toBe("ws-target");
    expect(cookie?.options?.httpOnly).toBe(true);
  });

  it("redirects back to /admin without setting a cookie when workspaceId is blank", async () => {
    asAdmin();
    const fd = new FormData();
    fd.set("workspaceId", "");

    const digest = await redirectOf(() => impersonateWorkspaceAction(fd));
    expect(digest).toContain("/admin");
    expect(cookieJar.has(IMPERSONATE_COOKIE_NAME)).toBe(false);
  });
});

describe("stopImpersonationAction", () => {
  it("rejects (404) for a non-admin session and leaves the cookie untouched", async () => {
    asNonAdmin();
    cookieJar.set(IMPERSONATE_COOKIE_NAME, { value: "ws-target" });

    await expect(stopImpersonationAction()).rejects.toMatchObject({
      digest: "NEXT_HTTP_ERROR_FALLBACK;404",
    });
    expect(cookieJar.has(IMPERSONATE_COOKIE_NAME)).toBe(true);
  });

  it("clears the cookie and redirects to /admin for the admin", async () => {
    asAdmin();
    cookieJar.set(IMPERSONATE_COOKIE_NAME, { value: "ws-target" });

    const digest = await redirectOf(() => stopImpersonationAction());
    expect(digest).toContain("/admin");
    expect(cookieJar.has(IMPERSONATE_COOKIE_NAME)).toBe(false);
  });
});
