import { SCOPE_COOKIE_NAME } from "@web/intake";
import { seeOtherRedirect } from "@web/return-to";
import { VIEWING_COOKIE_NAME } from "@web/viewing/viewing-cookie";
import type { NextResponse } from "next/server";

/**
 * Leave a viewer session (#1843, ADR 0112), the inverse of `POST /viewing`:
 * expire `wl_viewing` and the member scope (a scope of the shared workspace means
 * nothing in one's own), then back to `/app` — the session's own workspace.
 *
 * Needs no session or grant check: clearing a cookie can only take access away.
 * POST-only (ADR 0009) and with a relative `Location`, like `/demo/exit`, so the
 * Set-Cookie deletions reach the host the browser is on.
 */
export function POST(): NextResponse {
  const response = seeOtherRedirect("/app");
  response.cookies.delete(VIEWING_COOKIE_NAME);
  response.cookies.delete(SCOPE_COOKIE_NAME);
  return response;
}
