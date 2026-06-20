import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { DEMO_PERSONA_COOKIE_NAME } from "@web/demo/demo-context";

import { resolveStoreTarget, type StoreTarget } from "./store-resolver";

function isAuthConfigured(env: Record<string, string | undefined>): boolean {
  return Boolean(env.AUTH_GOOGLE_ID && env.AUTH_GOOGLE_SECRET);
}

/**
 * Read the request-scoped store target from the current session, env, and the
 * persona cookie. This is the server-side entry point: server components,
 * actions, and route handlers call this to decide which workspace (if any) to
 * open — an authenticated user's real workspace, a logged-out demo persona, or
 * the local no-auth single-user store (ADR 0030).
 *
 * `next-auth` is loaded lazily and only when auth is configured, so local and
 * demo runs — and their tests — never pull the auth stack into Node/Vitest.
 */
export async function readStoreTarget(): Promise<StoreTarget> {
  const env = process.env;
  const personaCookie = (await cookies()).get(DEMO_PERSONA_COOKIE_NAME)?.value;

  if (!isAuthConfigured(env)) {
    return resolveStoreTarget({ env, session: null, personaCookie });
  }

  const { auth } = await import("@web/auth");
  const session = await auth();
  return resolveStoreTarget({ env, session, personaCookie });
}

/**
 * Read the store target and redirect to the sign-in page when the request is
 * unauthenticated. Use this in pages that require a workspace; an authenticated
 * workspace, a demo persona, and the local store all flow through unchanged.
 */
export async function requireStoreTarget(): Promise<
  Exclude<StoreTarget, { kind: "unauthenticated" }>
> {
  const target = await readStoreTarget();
  if (target.kind === "unauthenticated") {
    redirect("/login");
  }
  return target;
}
