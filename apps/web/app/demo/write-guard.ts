/**
 * Demo write guard (PRD #297, S2 #300, ADR 0030). The read-only enforcement
 * seam: every mutating server action calls it FIRST, before any store access.
 * For a demo request it short-circuits the mutation — redirecting with a
 * friendly "deshabilitado en la demo" message via the existing error-redirect
 * intake — so a direct URL or POST cannot change anything. For a live request
 * (authenticated or local) it is a no-op and the action proceeds as before.
 *
 * Demo-ness is a per-request fact (the logged-out persona cookie) resolved by
 * the store seam, so the guard is async — `await guardDemoWrite(...)` on an
 * action's first line.
 */
import { redirect } from "next/navigation";

import { readStoreTarget } from "@web/read-store-target";
import { errorRedirectUrl } from "@web/intake";

export const DEMO_DISABLED_MESSAGE =
  "Acción deshabilitada en la demo — datos ficticios de solo lectura.";

/** Whether this request is the read-only demo (a logged-out persona). */
export async function isDemoMode(): Promise<boolean> {
  return (await readStoreTarget()).kind === "demo";
}

/**
 * For a demo request, abort a mutating action by redirecting back to
 * `currentUrl` with the "deshabilitado" message (the store is never touched).
 * No-op when live. Throws Next's redirect signal in demo mode — await it before
 * opening a store.
 */
export async function guardDemoWrite(currentUrl: string): Promise<void> {
  if (await isDemoMode()) {
    redirect(errorRedirectUrl(currentUrl, { message: DEMO_DISABLED_MESSAGE }));
  }
}
