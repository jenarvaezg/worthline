/**
 * Read-only write guard (PRD #297, S2 #300, ADR 0030; extended for admin
 * impersonation, #697). The read-only enforcement seam: every mutating server
 * action calls it FIRST, before any store access. For a demo request OR an
 * admin impersonating a workspace, it short-circuits the mutation —
 * redirecting with a friendly message via the existing error-redirect intake —
 * so a direct URL or POST cannot change anything. For a live request
 * (authenticated, non-impersonated, or local) it is a no-op and the action
 * proceeds as before.
 *
 * Demo-ness and impersonation are both per-request facts resolved by the store
 * seam, so the guard is async — `await guardDemoWrite(...)` on an action's
 * first line. Every existing mutating action already calls it that way, so
 * extending this ONE seam covers impersonation across the whole app with no
 * per-action change.
 */

import { errorRedirectUrl } from "@web/intake";

import { readStoreTarget } from "@web/read-store-target";
import { redirect } from "next/navigation";
import {
  DEMO_DISABLED_MESSAGE,
  IMPERSONATION_READONLY_MESSAGE,
} from "./write-guard-messages";

export { DEMO_DISABLED_MESSAGE, IMPERSONATION_READONLY_MESSAGE };

/** Whether this request is the read-only demo (a logged-out persona). */
export async function isDemoMode(): Promise<boolean> {
  return (await readStoreTarget()).kind === "demo";
}

/** Whether this request is an admin impersonating another workspace (#697) — read-only. */
export async function isImpersonating(): Promise<boolean> {
  const target = await readStoreTarget();
  return target.kind === "authenticated" && target.impersonatedEmail !== undefined;
}

/**
 * Whether this request must not write: the read-only demo, or an admin
 * impersonating a workspace (#1180). The non-redirecting form of
 * {@link guardDemoWrite}, for a mutating action that must refuse SILENTLY rather
 * than navigate — a `void` action fired mid-conversation from the client, where
 * throwing Next's redirect signal would be wrong. Same two conditions, so the
 * two guards can never disagree (asserted in `write-guard-impersonation.test.ts`).
 *
 * An action that redirects should still use `guardDemoWrite`: the user gets the
 * honest Spanish message instead of a write that quietly did nothing.
 */
export async function isWriteBlocked(): Promise<boolean> {
  const target = await readStoreTarget();
  return (
    target.kind === "demo" ||
    (target.kind === "authenticated" && target.impersonatedEmail !== undefined)
  );
}

/**
 * For a demo request OR an impersonated admin request, abort a mutating action
 * by redirecting back to `currentUrl` with the matching message (the store is
 * never touched). No-op when live. Throws Next's redirect signal — await it
 * before opening a store.
 */
export async function guardDemoWrite(currentUrl: string): Promise<void> {
  const target = await readStoreTarget();

  if (target.kind === "demo") {
    redirect(errorRedirectUrl(currentUrl, { message: DEMO_DISABLED_MESSAGE }));
  }

  if (target.kind === "authenticated" && target.impersonatedEmail !== undefined) {
    redirect(errorRedirectUrl(currentUrl, { message: IMPERSONATION_READONLY_MESSAGE }));
  }
}
