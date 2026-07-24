/**
 * Baseline options for worthline's own non-auth cookies (#1180): the scope
 * (`wl_scope`), privacy mode (`wl_privacy`), the demo persona
 * (`wl_demo_persona`) and admin impersonation (`wl_impersonate`).
 *
 * They all want the SAME transport posture, and each of them used to spell it
 * out at its own `cookies().set(...)` call — which is how `secure` came to be
 * missing from three of the four. One helper makes the posture a single
 * reviewable fact instead of a convention that a new cookie can quietly skip:
 *
 *   - `httpOnly` — no cookie is read from client JS; every consumer is a server
 *     read (`page-shell.ts`, `read-store-target.ts`, the route handlers).
 *   - `path: "/"` — they scope the whole app, not one route.
 *   - `sameSite: "lax"` — they must survive a top-level navigation back into the
 *     app (the `303` redirects these routes issue) but never ride a cross-site
 *     subrequest.
 *   - `secure` in production — the cookies carry tenancy-shaped state (which
 *     member's scope, which impersonated workspace); they must never be
 *     observable on a plain-http hop. Off outside production so local dev over
 *     `http://localhost` keeps working.
 *
 * NOT for the Auth.js session cookie: Auth.js owns its own naming and flags
 * (`__Secure-` prefix + `secure` derived from the canonical URL) — see
 * `auth.config.ts`, which owns the session's *lifetime*.
 *
 * `NODE_ENV` is read at call time (not captured at module load) so a test can
 * exercise both sides of the branch.
 */
export function appCookieOptions(extra?: { maxAge?: number }): {
  httpOnly: true;
  maxAge?: number;
  path: "/";
  sameSite: "lax";
  secure: boolean;
} {
  return {
    httpOnly: true,
    ...(extra?.maxAge === undefined ? {} : { maxAge: extra.maxAge }),
    path: "/",
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
  };
}
