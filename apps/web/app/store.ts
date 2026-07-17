/**
 * The web-level store seam (PRD #297, ADR 0029, ADR 0030). One place that
 * resolves the three request states (ADR 0030):
 *   - authenticated → the user's own workspace (libSQL URL + group token);
 *   - demo → an ephemeral in-memory libSQL database seeded from the persona
 *     specs, cached per process so warm navigation reuses the seed (#616);
 *     read-only by construction ("nothing the viewer does persists");
 *   - local → the env-configured single-user store (no-auth dev / tests).
 * Every read page and read route opens its store through here, so the behavior
 * lives in one seam rather than scattered across pages.
 *
 * The close policy is a property of the caller, not of a separate module (#1025):
 * `withStore` closes inline in a `finally`, `getRequestStore` defers to `after()`
 * (one connection per RSC request), and `openStore` hands the lifecycle to the
 * caller. All three share the one reachability guard and the one authorization
 * port; only the timing of `store.close()` differs.
 */

import { demoNowDate } from "@web/demo/demo-clock";
import { runBootstrapHealthcheck, type WorthlineStore } from "@worthline/db";
import type { LocalPersistenceStatus } from "@worthline/domain";
import { after } from "next/server";
import { cache } from "react";

import { openAuthorizedStore, type Principal, withAuthorizedStore } from "./principal";
import { isReachable, readStoreTarget } from "./read-store-target";
import type { StoreTarget } from "./store-resolver";

// Re-exported so request-scoped callers (pages, server actions) import both the
// store opener and its type from this seam — never from `@worthline/db` directly,
// whose `withStoreUnsafe` defaults to the local file path (ENOENT on Vercel's
// read-only FS) instead of resolving the authenticated workspace / demo target
// (ADR 0030), and — more importantly — opens with no principal at all (#998 S1).
export type { WorthlineStore } from "@worthline/db";

/** Synthesize the persistence status for the demo (no real connection to probe). */
function demoHealthcheck(now: string): LocalPersistenceStatus {
  const checkedAt = demoNowDate(now).toISOString();
  return {
    status: "ok",
    checkKey: "bootstrap.last_healthcheck_at",
    checkedAt,
    checkValue: checkedAt,
    databasePath: ":memory:",
    displayPath: "demo · datos en memoria",
  };
}

/**
 * The label the persistence footer shows for a hosted workspace. The raw libSQL
 * URL (`libsql://wl-<workspace>.turso.io`) must NEVER reach the rendered footer:
 * it exposes the internal database host and the workspace id on every page (PRD
 * #877 S6, #954 — the estreno leak fix). The friendly label carries the same
 * meaning ("your data lives in its own private database") without the plumbing.
 */
const WORKSPACE_DISPLAY_PATH = "tu espacio · base de datos privada";

/**
 * Synthesize the persistence status for an authenticated workspace WITHOUT a DB
 * round-trip (#445). The footer only renders `displayPath` + a render-time
 * "guardado" stamp and nothing branches on a real write, so probing the remote
 * workspace DB on every page render — a separate connection plus a write that no
 * reader consumes — was pure overhead. A genuinely unreachable or read-only
 * workspace still surfaces: read pages fail fast at `withStore()`, and writes
 * fail at the action that writes (with a proper error) instead of the old
 * behavior where a failed probe-write threw and bricked even read-only pages.
 *
 * `displayPath` is the FRIENDLY label (rendered in the shell footer, #954);
 * `databasePath` keeps the raw URL for the owner-only technical panel in Ajustes.
 */
function workspaceHealthcheck(dbUrl: string): LocalPersistenceStatus {
  const checkedAt = new Date().toISOString();
  return {
    status: "ok",
    checkKey: "bootstrap.last_healthcheck_at",
    checkedAt,
    checkValue: checkedAt,
    databasePath: dbUrl,
    displayPath: WORKSPACE_DISPLAY_PATH,
  };
}

/** Bootstrap healthcheck — pinned to the authenticated workspace or demo clock. */
export async function bootstrapHealthcheck(
  target?: StoreTarget,
): Promise<LocalPersistenceStatus> {
  // Reuse the request-scoped principal resolution (single reachability guard):
  // a resolved principal shares its shape with the reachable target, so we read
  // the same `dbUrl`/`now` fields off it without a second resolve or assert.
  const principal = await requirePrincipal(target);

  if (principal.kind === "authenticated") {
    // Synthesize instead of probing the remote workspace DB on every render
    // (#445) — no per-pageview write, no second connection. See workspaceHealthcheck.
    return workspaceHealthcheck(principal.dbUrl);
  }

  if (principal.kind === "demo") {
    return demoHealthcheck(principal.now);
  }

  return runBootstrapHealthcheck();
}

/**
 * Resolve the request's principal (or use the one passed explicitly), refusing
 * an unauthenticated request via the single reachability guard ({@link
 * isReachable}, #1025). This is the request-scoped adapter in front of the
 * authorization port: every RSC read/write reaches a workspace store only by
 * producing a {@link Principal} here first — and it is the ONE place the store
 * seam turns "unauthenticated" into a throw. The port itself cannot even be
 * called with `unauthenticated` (it is not a `Principal`), so there is no code
 * path to a store without one (#998 S1).
 */
async function requirePrincipal(target?: StoreTarget): Promise<Principal> {
  const resolved = target ?? (await readStoreTarget());
  if (!isReachable(resolved)) {
    throw new Error("Store opened without authentication");
  }
  return resolved;
}

/** Open a store. Caller owns the lifecycle (must call `store.close()`). */
export async function openStore(target?: StoreTarget): Promise<WorthlineStore> {
  return openAuthorizedStore(await requirePrincipal(target));
}

/** Run a unit of work against a freshly opened store, always closing it after. */
export async function withStore<T>(
  run: (store: WorthlineStore) => T | Promise<T>,
  target?: StoreTarget,
  label = "store",
): Promise<T> {
  return withAuthorizedStore(await requirePrincipal(target), run, label);
}

/**
 * One libSQL connection per RSC request, closed after the response (incl.
 * Suspense) — the `after()` close policy of the request-scoped seam. It reaches
 * the connection through the same {@link openStore} path (single reachability
 * guard, single port) as `withStore`; only the close TIMING differs: `withStore`
 * closes inline in a `finally`, this defers to `after()` (#1025).
 */
export const getRequestStore = cache(async (): Promise<WorthlineStore> => {
  const store = await openStore();
  after(() => {
    store.close();
  });
  return store;
});
