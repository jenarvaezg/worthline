import type { NextAuthConfig } from "next-auth";
import Google from "next-auth/providers/google";

/** A signed-in session lives 7 days (#1180) instead of Auth.js's 30-day default:
 * a stolen or forgotten session token has a bounded blast radius, and the app is
 * a single-tenant financial ledger where a month-long silent grant is too long. */
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 7;

/** Rotate the JWT at most once a day. An actively-used session keeps rolling
 * forward (so a daily visitor is never logged out) while an idle one still ages
 * out at {@link SESSION_MAX_AGE_SECONDS}; re-signing on every request would
 * write a `Set-Cookie` on each navigation for no security gain. */
const SESSION_UPDATE_AGE_SECONDS = 60 * 60 * 24;

export default {
  providers: [Google],
  session: {
    strategy: "jwt",
    maxAge: SESSION_MAX_AGE_SECONDS,
    updateAge: SESSION_UPDATE_AGE_SECONDS,
  },
  trustHost: true,
  pages: {
    signIn: "/login",
  },
} satisfies NextAuthConfig;
