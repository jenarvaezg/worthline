/**
 * The middleware's page-access gate (ADR 0030), as a pure decision so it can be
 * unit-tested without the Auth.js/edge wrapper. It answers only "should this
 * request be bounced to /login?" — which workspace an authenticated request then
 * opens is the store seam's concern, not the middleware's.
 */

// `/mcp-icon.svg` is the public connector icon claude.ai fetches (unauthenticated)
// to show in its listing; it must bypass the sign-in wall like the other public paths.
const PUBLIC_PATHS = new Set(["/login", "/mcp-icon.svg"]);

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
  // The agent-view MCP endpoint and its OAuth protected-resource metadata must
  // be reachable while logged out: an MCP client (claude.ai / Claude Code)
  // completes the OAuth handshake *before* any session exists, and the metadata
  // route advertises where to authorize. Bouncing them to /login would return
  // an HTML 302 that the client can't parse — the exact "Failed to parse JSON"
  // symptom this PRD fixes (ADR 0034).
  if (
    pathname.startsWith("/api/mcp") ||
    pathname === "/.well-known/oauth-protected-resource"
  ) {
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
