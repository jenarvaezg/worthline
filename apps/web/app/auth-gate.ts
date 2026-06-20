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
  pathname: string;
}): boolean {
  const { authConfigured, hasSession, pathname } = input;

  // Local no-auth mode: the control plane and sign-in never engage.
  if (!authConfigured) {
    return false;
  }
  if (hasSession) {
    return false;
  }
  // The sign-in route and Auth.js's own endpoints must stay reachable.
  if (pathname.startsWith("/api/auth") || PUBLIC_PATHS.has(pathname)) {
    return false;
  }
  return true;
}
