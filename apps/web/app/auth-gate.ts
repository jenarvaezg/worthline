/**
 * The middleware's page-access gate (ADR 0030), as a pure decision so it can be
 * unit-tested without the Auth.js/edge wrapper. It answers only "should this
 * request be bounced to /login?" — which workspace an authenticated request then
 * opens is the store seam's concern, not the middleware's.
 */

const PUBLIC_PATHS = new Set(["/login"]);

export function shouldRedirectToLogin(input: {
  authConfigured: boolean;
  hasSession: boolean;
  /** Whether the request carries the demo persona cookie (ADR 0030). */
  hasPersonaCookie?: boolean;
  pathname: string;
}): boolean {
  const { authConfigured, hasSession, hasPersonaCookie, pathname } = input;

  // Local no-auth mode: the control plane and sign-in never engage.
  if (!authConfigured) {
    return false;
  }
  if (hasSession) {
    return false;
  }
  // A logged-out demo request (persona cookie) gets the read-only demo, not the
  // sign-in wall (ADR 0030).
  if (hasPersonaCookie) {
    return false;
  }
  // The sign-in route, the public demo entry, and Auth.js's own endpoints must
  // stay reachable for a logged-out visitor.
  if (
    pathname.startsWith("/api/auth") ||
    pathname === "/demo" ||
    pathname.startsWith("/demo/") ||
    PUBLIC_PATHS.has(pathname)
  ) {
    return false;
  }
  return true;
}
