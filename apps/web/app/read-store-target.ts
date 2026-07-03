import { cache } from "react";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { createControlPlaneStore, type ControlPlaneStore } from "@worthline/db";

import { IMPERSONATE_COOKIE_NAME } from "@web/admin/impersonate-cookie";
import { DEMO_PERSONA_COOKIE_NAME } from "@web/demo/demo-context";

import {
  normalizeAdminEmail,
  resolveStoreTarget,
  type StoreTarget,
} from "./store-resolver";

function isAuthConfigured(env: Record<string, string | undefined>): boolean {
  return Boolean(env.AUTH_GOOGLE_ID && env.AUTH_GOOGLE_SECRET);
}

/**
 * Read a cookie by name, or undefined when there is no request scope to read
 * it from. A server action invoked directly in a unit test runs outside
 * Next's request context, where `cookies()` throws — that simply means "no
 * cookie", so the request resolves as if it were absent. In production every
 * caller is inside a request, so the cookie is always read normally.
 */
async function readCookie(name: string): Promise<string | undefined> {
  try {
    return (await cookies()).get(name)?.value;
  } catch {
    return undefined;
  }
}

/**
 * The current session's verified email, or null when there is none — auth not
 * configured (local no-auth mode), no session, or the persona cookie's demo
 * (which never carries a real Auth.js session). Used by `guardAdmin` so the
 * "is this request the admin" check reuses the exact same lazy session read as
 * `readStoreTarget`, rather than a second copy of the auth-configured/dynamic-
 * import dance.
 */
export async function readSessionEmail(): Promise<string | null> {
  const env = process.env;
  if (!isAuthConfigured(env)) return null;

  const { auth } = await import("@web/auth");
  const session = await auth();
  return session?.user?.email ? normalizeAdminEmail(session.user.email) : null;
}

/**
 * Resolve the admin impersonation target from the `wl_impersonate` cookie's
 * workspace id, via a control-plane lookup — or null whenever there is nothing
 * to resolve (no cookie, control plane not configured, or unknown workspace
 * id). This does NOT check whether the caller is admin — that decision is
 * `resolveStoreTarget`'s alone, recomputed from the request's own session on
 * every call (#697). Looking this up unconditionally (whenever the cookie is
 * present, regardless of who sent it) keeps that the ONE gate: a forged cookie
 * from any visitor resolves to a real workspace ref here, and is discarded
 * there.
 */
export async function lookupImpersonationTarget(input: {
  workspaceId: string | undefined;
  env: Record<string, string | undefined>;
  openControlPlane?: () => Promise<ControlPlaneStore>;
}): Promise<{ workspaceId: string; dbUrl: string; email: string } | null> {
  const { workspaceId, env } = input;
  if (!workspaceId) return null;

  const controlPlaneUrl = env.WORTHLINE_CONTROL_PLANE_DB_URL;
  if (!controlPlaneUrl) return null;

  const open =
    input.openControlPlane ??
    (() =>
      createControlPlaneStore({
        url: controlPlaneUrl,
        ...(env.WORTHLINE_DB_AUTH_TOKEN
          ? { authToken: env.WORTHLINE_DB_AUTH_TOKEN }
          : {}),
      }));

  const controlPlane = await open();
  try {
    const found = await controlPlane.getWorkspaceWithOwner(workspaceId);
    if (!found || !found.ownerEmail) return null;
    return { workspaceId: found.id, dbUrl: found.dbUrl, email: found.ownerEmail };
  } finally {
    controlPlane.close();
  }
}

/**
 * Read the request-scoped store target from the current session, env, the
 * persona cookie, and (for an admin session) the impersonation cookie. This is
 * the server-side entry point: server components, actions, and route handlers
 * call this to decide which workspace (if any) to open — an authenticated
 * user's real workspace, that workspace overridden by an admin's impersonation
 * target, a logged-out demo persona, or the local no-auth single-user store
 * (ADR 0030).
 *
 * `next-auth` is loaded lazily and only when auth is configured, so local and
 * demo runs — and their tests — never pull the auth stack into Node/Vitest.
 */
export const readStoreTarget = cache(async (): Promise<StoreTarget> => {
  const env = process.env;
  const personaCookie = await readCookie(DEMO_PERSONA_COOKIE_NAME);

  if (!isAuthConfigured(env)) {
    return resolveStoreTarget({ env, session: null, personaCookie });
  }

  const { auth } = await import("@web/auth");
  const session = await auth();
  const impersonateCookie = await readCookie(IMPERSONATE_COOKIE_NAME);
  const impersonateWorkspace = await lookupImpersonationTarget({
    workspaceId: impersonateCookie,
    env,
  });

  return resolveStoreTarget({ env, session, personaCookie, impersonateWorkspace });
});

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
