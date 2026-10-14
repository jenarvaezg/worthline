/**
 * Leaving a viewer session (#1843): `POST /viewing/exit` expires the viewer and
 * scope cookies and returns to the session's own workspace. No session or grant
 * check: clearing a cookie can only take access away.
 */

import { SCOPE_COOKIE_NAME } from "@web/intake";
import { VIEWING_COOKIE_NAME } from "@web/viewing/viewing-cookie";
import { describe, expect, test } from "vitest";
import { POST } from "./route";

describe("POST /viewing/exit", () => {
  test("expires the viewer and scope cookies and 303s to /app", async () => {
    const response = POST();

    expect(response.status).toBe(303);
    // Relative, so the Set-Cookie deletions reach the host the browser is on.
    expect(response.headers.get("location")).toBe("/app");
    const setCookie = response.headers.getSetCookie();
    for (const name of [VIEWING_COOKIE_NAME, SCOPE_COOKIE_NAME]) {
      expect(setCookie.find((cookie) => cookie.startsWith(`${name}=`))).toMatch(
        /Expires=Thu, 01 Jan 1970/i,
      );
    }
  });
});
