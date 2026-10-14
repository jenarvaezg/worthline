/**
 * Entering a viewer session (#1843, ADR 0112). `POST /viewing` only touches
 * cookies, like `/scope`: it sets `wl_viewing` — and drops the member scope,
 * which belongs to the workspace being left — only after checking that THIS
 * session holds a viewer grant on that workspace. The cookie would grant nothing
 * without the grant anyway (every request re-checks it); checking here keeps a
 * dead cookie from ever being set.
 */

import { SCOPE_COOKIE_NAME } from "@web/intake";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("@web/read-store-target", () => ({
  lookupViewerAccess: vi.fn(),
  readSessionEmail: vi.fn(),
}));

import { lookupViewerAccess, readSessionEmail } from "@web/read-store-target";

import { POST } from "./route";
import { VIEWING_COOKIE_MAX_AGE_SECONDS, VIEWING_COOKIE_NAME } from "./viewing-cookie";

function viewingPost(body: string): NextRequest {
  return new NextRequest("http://127.0.0.1:3001/viewing", {
    body,
    headers: { "content-type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
}

const ACCESS = {
  dbUrl: "libsql://wl-jorge.turso.io",
  ownerEmail: "jorge@example.com",
  readOnlyToken: "read-only-jorge",
  viewerEmail: "lucia@example.com",
  workspaceId: "ws-jorge",
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(readSessionEmail).mockResolvedValue("lucia@example.com");
  vi.mocked(lookupViewerAccess).mockResolvedValue(ACCESS);
});

describe("POST /viewing", () => {
  test("with this session's grant: sets the cookie, drops the scope, 303 to /app", async () => {
    const response = await POST(viewingPost("workspaceId=ws-jorge"));

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/app");
    expect(lookupViewerAccess).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionEmail: "lucia@example.com",
        workspaceId: "ws-jorge",
      }),
    );
    const cookie = response.cookies.get(VIEWING_COOKIE_NAME);
    expect(cookie?.value).toBe("ws-jorge");
    expect(cookie?.httpOnly).toBe(true);
    expect(cookie?.maxAge).toBe(VIEWING_COOKIE_MAX_AGE_SECONDS);
    expect(response.cookies.get(SCOPE_COOKIE_NAME)?.value).toBe("");
  });

  test("without a grant: 303 to /ajustes and no cookie", async () => {
    vi.mocked(lookupViewerAccess).mockResolvedValue(null);

    const response = await POST(viewingPost("workspaceId=ws-mallory"));

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/ajustes");
    expect(response.cookies.get(VIEWING_COOKIE_NAME)).toBeUndefined();
  });

  test("a grant found for another email does not set the cookie", async () => {
    vi.mocked(lookupViewerAccess).mockResolvedValue({
      ...ACCESS,
      viewerEmail: "mallory@example.com",
    });

    const response = await POST(viewingPost("workspaceId=ws-jorge"));

    expect(response.headers.get("location")).toBe("/ajustes");
    expect(response.cookies.get(VIEWING_COOKIE_NAME)).toBeUndefined();
  });

  test("without a session: 303 to /login, no lookup and no cookie", async () => {
    vi.mocked(readSessionEmail).mockResolvedValue(null);

    const response = await POST(viewingPost("workspaceId=ws-jorge"));

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/login");
    expect(lookupViewerAccess).not.toHaveBeenCalled();
    expect(response.cookies.get(VIEWING_COOKIE_NAME)).toBeUndefined();
  });

  test("without a workspace id: 303 to /ajustes, no lookup and no cookie", async () => {
    const response = await POST(viewingPost("workspaceId=%20"));

    expect(response.headers.get("location")).toBe("/ajustes");
    expect(lookupViewerAccess).not.toHaveBeenCalled();
    expect(response.cookies.get(VIEWING_COOKIE_NAME)).toBeUndefined();
  });
});
