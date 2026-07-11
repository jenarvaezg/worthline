/**
 * The proxy's page-access gate (ADR 0030), as a pure decision so it can be
 * unit-tested without the Auth.js/edge wrapper. It answers only "should this
 * request be bounced to /login?" — which workspace an authenticated request then
 * opens is the store seam's concern, not the proxy's.
 */

// Static public assets fetched before a session exists must bypass the sign-in
// wall; otherwise PWA install/SW registration receives the login HTML.
// /landing is the public landing page (#951, PRD #877) — S6 promotes it to `/`
// and this entry follows it there.
const PUBLIC_PATHS = new Set([
  "/login",
  "/landing",
  "/manifest.json",
  "/mcp-icon.svg",
  "/sw.js",
]);

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
  //
  // The daily-snapshot cron (ADR 0037) is likewise a session-less machine
  // endpoint: Vercel Cron calls it with `Authorization: Bearer CRON_SECRET` and
  // no Auth.js session, so the gate must let it reach its own bearer check
  // instead of 307-ing it to /login (which silently no-ops the job).
  if (
    pathname.startsWith("/api/mcp") ||
    pathname.startsWith("/api/cron") ||
    pathname === "/.well-known/oauth-protected-resource"
  ) {
    return false;
  }
  // The provisional root (`/` → `/app`, #949), sign-in route, public demo entry,
  // and Auth.js endpoints must stay reachable for a logged-out visitor.
  if (
    pathname === "/" ||
    pathname.startsWith("/api/auth") ||
    pathname === "/demo" ||
    pathname.startsWith("/demo/") ||
    PUBLIC_PATHS.has(pathname)
  ) {
    return false;
  }
  return true;
}
