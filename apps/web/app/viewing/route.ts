import { appCookieOptions } from "@web/app-cookie";
import { comparableEmail } from "@web/comparable-email";
import { SCOPE_COOKIE_NAME } from "@web/intake";
import { lookupViewerAccess, readSessionEmail } from "@web/read-store-target";
import { seeOtherRedirect } from "@web/return-to";
import type { NextRequest, NextResponse } from "next/server";

import { VIEWING_COOKIE_MAX_AGE_SECONDS, VIEWING_COOKIE_NAME } from "./viewing-cookie";

/**
 * Enter a viewer session (#1843, ADR 0112): view a workspace someone shared with
 * this session's identity. A route handler that only touches cookies, like
 * `/scope` and `/privacy`; the form that posts here is
 * «Compartidos contigo» (`viewing/shared-with-you.tsx`, #1844).
 *
 *   - no session → `/login`;
 *   - no viewer grant of THIS session's email on that workspace → `/ajustes`,
 *     with no cookie: one that would grant nothing is never set;
 *   - otherwise → `wl_viewing` set to the workspace id, the member scope (which
 *     belongs to the workspace being left) dropped, and `/app`.
 *
 * The cookie is not the authority: every later request re-reads the grant
 * (`readStoreTarget`), so a revocation takes effect on the next request whatever
 * this route set. Every `Location` is relative, so the cookie changes reach the
 * host the browser is on. POST-only (ADR 0009): a prefetched GET must never
 * switch workspaces.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const sessionEmail = await readSessionEmail();
  if (!sessionEmail) {
    return seeOtherRedirect("/login");
  }

  const formData = await request.formData();
  const workspaceId = String(formData.get("workspaceId") ?? "").trim();
  if (!workspaceId) {
    return seeOtherRedirect("/ajustes");
  }

  const access = await lookupViewerAccess({
    env: process.env,
    sessionEmail,
    workspaceId,
  });
  if (!access || comparableEmail(access.viewerEmail) !== sessionEmail) {
    return seeOtherRedirect("/ajustes");
  }

  const response = seeOtherRedirect("/app");
  response.cookies.set(
    VIEWING_COOKIE_NAME,
    access.workspaceId,
    appCookieOptions({ maxAge: VIEWING_COOKIE_MAX_AGE_SECONDS }),
  );
  response.cookies.delete(SCOPE_COOKIE_NAME);
  return response;
}
