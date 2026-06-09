"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { SCOPE_COOKIE_NAME } from "../intake";

/**
 * Server action: set the wl_scope cookie to the submitted scope ID and
 * redirect back to the page that posted the form.
 */
export async function setScopeAction(formData: FormData): Promise<never> {
  const scopeId = String(formData.get("scopeId") ?? "").trim();
  const returnTo = String(formData.get("returnTo") ?? "/").trim() || "/";

  if (scopeId) {
    const jar = await cookies();
    jar.set(SCOPE_COOKIE_NAME, scopeId, {
      httpOnly: true,
      path: "/",
      // Session cookie — no maxAge — so the browser discards it on exit if
      // the user prefers; next load defaults back to household gracefully.
      sameSite: "lax",
    });
  }

  redirect(returnTo);
}
