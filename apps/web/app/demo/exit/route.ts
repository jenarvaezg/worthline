import { DEMO_PERSONA_COOKIE_NAME } from "@web/demo/demo-context";
import { SCOPE_COOKIE_NAME } from "@web/intake";
import { NextResponse } from "next/server";

/**
 * Demo exit route (#464), the inverse of `/demo/persona`. POST clears the
 * `wl_demo_persona` cookie (which is what flips a logged-out request into the
 * demo) plus the `wl_scope` cookie, then sends the visitor to `/login`. With the
 * persona cookie gone, `/` resolves to the logged-out branch again.
 *
 * POST-only on purpose (ADR 0009): a GET `<Link>` would let Next's prefetch fire
 * the exit before the user clicks. Cookie is httpOnly, so JS can't clear it — the
 * server must. The `Location` is RELATIVE for the same reason as the persona
 * route: an absolute redirect can switch host (127.0.0.1 ⇄ localhost / proxy
 * origin) and the Set-Cookie deletions, scoped to the request host, would not be
 * sent to the new host — silently leaving the visitor in the demo.
 */
export function POST(): NextResponse {
  const response = new NextResponse(null, {
    status: 303,
    headers: { Location: "/login" },
  });
  response.cookies.delete(DEMO_PERSONA_COOKIE_NAME);
  response.cookies.delete(SCOPE_COOKIE_NAME);
  return response;
}
