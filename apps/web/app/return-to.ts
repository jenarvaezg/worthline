import { NextResponse } from "next/server";

/** Gated product entry — the dashboard and its default post-login destination. */
export const DEFAULT_APP_PATH = "/app";

/**
 * A 303 redirect to a same-origin path with a RELATIVE `Location` (#1179).
 *
 * `NextResponse.redirect` demands an absolute URL, usually built off
 * `request.url` — but the host Next reports there (`localhost`) can differ from
 * the one in the browser's address bar (`127.0.0.1`, or a proxied host). A form
 * POST answered with a redirect gets the redirect target re-checked against CSP
 * `form-action 'self'`, so that host drift reads as a cross-origin hop and logs
 * a violation (it broke the e2e scope-switch journeys under the report-only
 * CSP). A relative `Location` (RFC 9110 §10.2.2) resolves against the
 * browser's own origin — exactly what these same-origin redirects mean.
 */
export function seeOtherRedirect(path: string): NextResponse {
  return new NextResponse(null, { headers: { location: path }, status: 303 });
}

/**
 * Validate a `returnTo` query param: only same-origin relative paths are
 * accepted. Rejects absolute URLs (`https://…`) and protocol-relative paths
 * (`//evil.com`) to block open redirects.
 */
export function parseReturnTo(
  raw: string | undefined | null,
  fallback: string = DEFAULT_APP_PATH,
): string {
  const trimmed = (raw ?? "").trim();
  if (trimmed.startsWith("/") && !trimmed.startsWith("//")) {
    return trimmed;
  }
  return fallback;
}

/** Build `/login?returnTo=…` for an unauthenticated gate redirect. */
export function buildLoginRedirectUrl(
  origin: string,
  pathname: string,
  search = "",
): URL {
  const url = new URL("/login", origin);
  url.searchParams.set("returnTo", parseReturnTo(`${pathname}${search}`));
  return url;
}
