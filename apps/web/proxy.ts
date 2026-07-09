import authConfig from "@web/auth.config";
import { shouldRedirectToLogin } from "@web/auth-gate";
import { DEMO_PERSONA_COOKIE_NAME } from "@web/demo/demo-context";
import { NextResponse } from "next/server";
import NextAuth from "next-auth";

const { auth } = NextAuth(authConfig);

export default auth((req) => {
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
    return NextResponse.redirect(new URL("/login", req.nextUrl.origin));
  }

  return undefined;
});

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.png$).*)"],
};
