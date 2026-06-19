/**
 * Demo write guard (PRD #297, S2 #300, ADR 0023). The read-only enforcement seam:
 * every mutating server action calls it FIRST, before any store access. In demo
 * mode it short-circuits the mutation — redirecting with a friendly
 * "deshabilitado en la demo" message via the existing error-redirect intake — so
 * a direct URL or POST on a warm serverless instance cannot change anything. With
 * `DEMO` unset it is a no-op and the action proceeds exactly as before.
 *
 * Enabled-ness is an environment fact (no cookie needed), so the guard stays
 * synchronous and drops into an action's first line without changing its shape.
 */
import { redirect } from "next/navigation";

import { resolveDemoContext } from "@web/demo/demo-context";
import { errorRedirectUrl } from "@web/intake";

export const DEMO_DISABLED_MESSAGE =
  "Acción deshabilitada en la demo — datos ficticios de solo lectura.";

/** Whether the running build is the read-only demo (environment only). */
export function isDemoMode(): boolean {
  return resolveDemoContext({ demoFlag: process.env.DEMO }).enabled;
}

/**
 * In demo mode, abort a mutating action by redirecting back to `currentUrl` with
 * the "deshabilitado" message (the store is never touched). No-op when live.
 * Throws Next's redirect signal in demo mode — call it before opening a store.
 */
export function guardDemoWrite(currentUrl: string): void {
  if (isDemoMode()) {
    redirect(errorRedirectUrl(currentUrl, { message: DEMO_DISABLED_MESSAGE }));
  }
}
