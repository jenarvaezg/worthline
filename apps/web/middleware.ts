import NextAuth from "next-auth";
import { NextResponse } from "next/server";

import authConfig from "@web/auth.config";
import { resolveStoreTarget } from "@web/store-resolver";

const { auth } = NextAuth(authConfig);

const PUBLIC_PATHS = new Set(["/login"]);

export default auth((req) => {
  const authConfigured = Boolean(
    process.env.AUTH_GOOGLE_ID && process.env.AUTH_GOOGLE_SECRET,
  );
  if (!authConfigured) {
    return;
  }

  const target = resolveStoreTarget({ env: process.env, session: req.auth });
  if (target.kind !== "unauthenticated") {
    return;
  }

  const { pathname } = req.nextUrl;
  if (pathname.startsWith("/api/auth") || PUBLIC_PATHS.has(pathname)) {
    return;
  }

  return NextResponse.redirect(new URL("/login", req.nextUrl.origin));
});

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.png$).*)"],
};
