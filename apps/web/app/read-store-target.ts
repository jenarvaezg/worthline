import { redirect } from "next/navigation";

import { resolveStoreTarget, type StoreTarget } from "./store-resolver";

function isAuthConfigured(env: Record<string, string | undefined>): boolean {
  return Boolean(env.AUTH_GOOGLE_ID && env.AUTH_GOOGLE_SECRET);
}

/**
 * Read the request-scoped store target from the current session and env.
 * This is the server-side entry point: server components, actions, and route
 * handlers call this to decide which workspace (if any) to open.
 *
 * `next-auth` is loaded lazily and only when auth is configured, so local and
 * demo runs — and their tests — never pull the auth stack into Node/Vitest.
 */
export async function readStoreTarget(): Promise<StoreTarget> {
  const env = process.env;
  if (!isAuthConfigured(env)) {
    return resolveStoreTarget({ env, session: null });
  }

  const { auth } = await import("@web/auth");
  const session = await auth();
  return resolveStoreTarget({ env, session });
}

/**
 * Read the store target and redirect to the sign-in page when the request is
 * unauthenticated. Use this in pages that require a workspace.
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
