/**
 * The viewer-session cookie (#1843, ADR 0112). `POST /viewing` sets it to the id
 * of a workspace someone shared with this session's identity, and
 * `POST /viewing/exit` clears it. Kept in its own dependency-free module (like
 * `IMPERSONATE_COOKIE_NAME` in `admin/impersonate-cookie.ts`) so the reader
 * (`read-store-target.ts`) and the route handlers import the name without a
 * cycle.
 *
 * CRITICAL: the value is NOT signed, and grants nothing by itself. Every request
 * re-reads the viewer grant of THIS session's email for that workspace
 * (`readViewerAccess`), and `resolveStoreTarget` recompares the email — so a
 * hand-crafted cookie, a revoked grant or another person's workspace id resolves
 * exactly as if the cookie were absent.
 */
export const VIEWING_COOKIE_NAME = "wl_viewing";

/** Bounded lifetime: a forgotten viewer session decays rather than lingers. */
export const VIEWING_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 12;
