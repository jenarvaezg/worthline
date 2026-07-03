/**
 * The impersonation cookie (#697, ADR 0030). Set by `impersonateWorkspaceAction`
 * to the target workspace's id, and cleared by `stopImpersonationAction`. Kept
 * in its own dependency-free module (mirroring `DEMO_PERSONA_COOKIE_NAME` in
 * `demo/demo-context.ts`) so both `read-store-target.ts` (reads it) and
 * `admin/actions.ts` (writes it, a "use server" module that can only export
 * async actions) can import the name without a cycle.
 *
 * CRITICAL: the value is NOT signed. It grants nothing by itself — every
 * resolution re-checks that the CURRENT request's session is the admin (see
 * `resolveStoreTarget` in `store-resolver.ts`), so a hand-crafted cookie on a
 * non-admin or logged-out request is inert.
 */
export const IMPERSONATE_COOKIE_NAME = "wl_impersonate";
