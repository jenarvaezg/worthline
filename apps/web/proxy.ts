import authConfig from "@web/auth.config";
import { shouldRedirectToLogin } from "@web/auth-gate";
import { DEMO_PERSONA_COOKIE_NAME } from "@web/demo/demo-context";
import { shouldInvokeProxy } from "@web/proxy-match";
import { buildLoginRedirectUrl } from "@web/return-to";
import { NextResponse } from "next/server";
import NextAuth from "next-auth";

const { auth } = NextAuth(authConfig);

const gated = auth((req) => {
  const authConfigured = Boolean(
    process.env.AUTH_GOOGLE_ID && process.env.AUTH_GOOGLE_SECRET,
  );

  // Only the page-access gate runs here (edge). Which workspace an authenticated
  // request opens — and which persona a demo request seeds — is resolved later
  // in the store seam (Node), off the JWT / the persona cookie.
  if (
    shouldRedirectToLogin({
      authConfigured,
      hasSession: Boolean(req.auth),
      hasPersonaCookie: Boolean(req.cookies.get(DEMO_PERSONA_COOKIE_NAME)?.value),
      pathname: req.nextUrl.pathname,
    })
  ) {
    return NextResponse.redirect(
      buildLoginRedirectUrl(req.nextUrl.origin, req.nextUrl.pathname, req.nextUrl.search),
    );
  }

  return undefined;
});

/**
 * Skip Auth.js on public/static paths so they never decrypt a JWT (#1536).
 * The matcher already keeps the lambda off those paths; this is the same
 * decision if a request still arrives (or in tests).
 */
export default function proxy(...args: Parameters<typeof gated>) {
  const req = args[0];
  if (!shouldInvokeProxy(req.nextUrl.pathname)) {
    return NextResponse.next();
  }
  return gated(...args);
}

// Literal string: Next parses `config.matcher` statically and rejects an import.
export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|api/cron|api/auth|api/mcp|api/billing/webhook|\\.well-known|login(?:/|$)|demo(?:/|$)|.*\\.(?:ico|png|svg|jpe?g|gif|webp|json|js|txt|xml|map|webmanifest|woff2?)$).+)",
  ],
};
