/**
 * The proxy's page-access gate (ADR 0030), as a pure decision so it can be
 * unit-tested without the Auth.js/edge wrapper. It answers only "should this
 * request be bounced to /login?" — which workspace an authenticated request then
 * opens is the store seam's concern, not the proxy's.
 */

// Static public assets fetched before a session exists must bypass the sign-in
// wall; otherwise PWA install/SW registration receives the login HTML.
// The public landing now lives at `/` (estreno, #954) — see the `pathname === "/"`
// branch below — so it no longer needs a dedicated `/landing` entry here.
const PUBLIC_PATHS = new Set(["/login", "/manifest.json", "/mcp-icon.svg", "/sw.js"]);

/**
 * Session-less paths. Checked BEFORE JWT/session so a public request never
 * pays Auth.js (#1536). The proxy matcher also uses this so those requests
 * never invoke the Node lambda at all.
 */
export function isPublicPath(pathname: string): boolean {
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
    pathname.startsWith("/.well-known")
  ) {
    return true;
  }
  // The public landing (`/`, estreno #954), sign-in route, public demo entry,
  // and Auth.js endpoints must stay reachable for a logged-out visitor.
  return (
    pathname === "/" ||
    pathname.startsWith("/api/auth") ||
    pathname === "/demo" ||
    pathname.startsWith("/demo/") ||
    PUBLIC_PATHS.has(pathname)
  );
}

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
  // Public paths first: the JWT must not be the thing that decides the route
  // was public (#1536). `proxy.ts` also skips Auth.js entirely when this is true.
  if (isPublicPath(pathname)) {
    return false;
  }
  if (hasSession) {
    return false;
  }
  // A logged-out demo request (persona cookie) gets the read-only demo, not the
  // sign-in wall (ADR 0030). Checked after public paths: `/patrimonio` is gated,
  // and the cookie is what lets a demo through without a session.
  if (hasPersonaCookie) {
    return false;
  }
  return true;
}
