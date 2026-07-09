/**
 * The admin gate (#697, ADR 0030), mirroring `demo/write-guard.ts`'s shape:
 * one seam that decides "is this request the admin", called from the /admin
 * page AND as the first line of every admin server action (defense in depth —
 * a direct POST to an admin action with no session must reject identically to
 * the page, never relying on the page having gated it).
 *
 * The gate is a single comparison: the current session's email against
 * `WORTHLINE_ADMIN_EMAIL`. No env var ⇒ no admin, ever. Every other case —
 * a different user, logged out, or the read-only demo (which never carries a
 * real Auth.js session) — fails the comparison the same way, so `notFound()`
 * fires uniformly. The response is byte-identical to any unknown URL: no
 * distinguishing "wrong user" from "route doesn't exist".
 */

import { readSessionEmail } from "@web/read-store-target";
import { normalizeAdminEmail } from "@web/store-resolver";
import { notFound } from "next/navigation";

export interface AdminContext {
  /** The confirmed admin's email — normalized (trim + lowercase) WORTHLINE_ADMIN_EMAIL. */
  email: string;
}

export async function guardAdmin(): Promise<AdminContext> {
  const adminEmail = normalizeAdminEmail(process.env.WORTHLINE_ADMIN_EMAIL);
  if (!adminEmail) {
    notFound();
  }

  const email = await readSessionEmail();
  if (email !== adminEmail) {
    notFound();
  }

  return { email };
}
