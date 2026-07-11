"use server";

import { guardAdmin } from "@web/admin/guard-admin";
import { IMPERSONATE_COOKIE_NAME } from "@web/admin/impersonate-cookie";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

/** Bounded lifetime (mirrors the persona cookie): a forgotten impersonation
 * session must decay rather than silently linger. */
const IMPERSONATE_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 4;

/**
 * Start impersonating a workspace (#697, ADR 0030). `guardAdmin` runs FIRST —
 * a direct POST to this action without an admin session 404s exactly like the
 * page, never relying on the /admin page having gated the click. The cookie
 * alone grants nothing: `read-store-target.ts` re-verifies the admin session
 * on every subsequent request before honoring it.
 */
export async function impersonateWorkspaceAction(formData: FormData): Promise<never> {
  await guardAdmin();

  const workspaceId = String(formData.get("workspaceId") ?? "").trim();
  if (!workspaceId) {
    redirect("/admin");
  }

  const jar = await cookies();
  jar.set(IMPERSONATE_COOKIE_NAME, workspaceId, {
    httpOnly: true,
    maxAge: IMPERSONATE_COOKIE_MAX_AGE_SECONDS,
    path: "/",
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
  });
  redirect("/app");
}

/** Stop impersonating: clear the cookie and return to /admin. Guarded like every admin action. */
export async function stopImpersonationAction(): Promise<never> {
  await guardAdmin();

  const jar = await cookies();
  jar.delete(IMPERSONATE_COOKIE_NAME);
  redirect("/admin");
}
