import NextAuth from "next-auth";
import { NextResponse } from "next/server";

import authConfig from "@web/auth.config";
import { shouldRedirectToLogin } from "@web/auth-gate";

const { auth } = NextAuth(authConfig);

export default auth((req) => {
  const authConfigured = Boolean(
    process.env.AUTH_GOOGLE_ID && process.env.AUTH_GOOGLE_SECRET,
  );

  // Only the page-access gate runs here (edge). Which workspace an authenticated
  // request opens is resolved later in the store seam (Node), off the JWT.
  if (
    shouldRedirectToLogin({
      authConfigured,
      hasSession: Boolean(req.auth),
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
