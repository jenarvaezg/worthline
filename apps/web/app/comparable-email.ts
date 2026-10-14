/**
 * Trimmed and lower-cased: the one comparable form of an email address on the
 * web side (#697, #1843, #1844). Every comparison of two addresses goes through
 * it — the deployed `WORTHLINE_ADMIN_EMAIL` against the session's, the viewer
 * grant's against the session's, the address the owner types against the list —
 * so a stray capital or trailing space never compares a normalized value against
 * a raw one. A missing value is the empty string, which matches no real address.
 *
 * Pure and dependency-free, so the client island of «Acceso de solo lectura»
 * ships it too. `@worthline/db` keeps its own (`comparable-email.ts`) for the
 * control plane's lookups; the two are the same rule on either side of the
 * package boundary.
 */
export function comparableEmail(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase();
}
