/**
 * The authorization port (PRD #998 S1/S2, decision #892 — adopción Sure banda 2).
 *
 * A workspace's data can only be reached by presenting a {@link Principal}:
 * the port's entry points take one BY VALUE, so the old runtime
 * `assertReachable` check ("Store opened without authentication") becomes a
 * COMPILE-TIME guarantee — the `unauthenticated` state is unrepresentable as a
 * `Principal`, so a store cannot be constructed without one.
 *
 * EVERY surface now starts from a principal and reaches a workspace store ONLY
 * through here (#998 S2):
 *   - RSC (pages/layouts/server actions) → `@web/store`, which resolves the
 *     request's principal and calls the port;
 *   - MCP (`/api/mcp`) → `internal-catalog.ts` resolves the token's principal
 *     via `storeTargetFromMcpAuth` + the shared `resolveStoreTarget`, then calls
 *     the port through `@web/store`;
 *   - REST `/api/v1/agent-view/**` → `runAgentViewStore`, a `local` principal
 *     (the loopback + capability-token guard is the grant, #328);
 *   - cron (`/api/cron/snapshot`) → a `system` principal carrying its own
 *     workspace coordinates.
 * The raw opener lives in `@worthline/db` under a deliberately unsafe name
 * (`createWorthlineStoreUnsafe`) so no surface grabs it by accident; this port is
 * its only authorized wrapper. The sole remaining direct callers are operational
 * scripts (`scripts/**`) and persistence tests — not request-reachable surfaces,
 * and outside the tripwire of #892.
 *
 * GRANT RE-CHECK POLICY (unified, #998 S2). The port TRUSTS the principal it is
 * handed; verifying that the caller is entitled to that workspace — the "grant" —
 * is each surface's RESOLVER responsibility, performed once at the boundary
 * BEFORE a principal exists, never re-checked here. The cadence of that check is
 * the surface credential's natural cadence, and deliberately differs (forcing one
 * cadence on all would either add a control-plane round-trip to every RSC render,
 * avoided by #445, or let a revoked MCP token linger until expiry):
 *   - web: the workspace is pinned into the Auth.js JWT at sign-in and trusted
 *     for the JWT's lifetime — no per-request control-plane re-check;
 *   - MCP: the bearer token is verified per request (`verifyMcpToken`), which
 *     re-resolves the workspace claims from the control plane on every call;
 *   - cron: a deploy-configured `system` actor (CRON_SECRET) with no per-workspace
 *     grant — it iterates every workspace by construction;
 *   - local: single-user no-auth; the loopback + capability token IS the grant.
 * The invariant the port enforces is narrower and absolute: no store without a
 * principal. WHO may hold each principal is settled upstream, at these cadences.
 */

import { demoAsOfDateKey } from "@web/demo/demo-clock";
import { getDemoStore } from "@web/demo/store-provider";
import type { WorthlineStore, WorthlineStoreOptions } from "@worthline/db";
import { createWorthlineStoreUnsafe } from "@worthline/db/unsafe-store";

import { perfEnd, perfStart } from "./perf-log";
import type { StoreTarget } from "./store-resolver";

/**
 * The authorized identity behind a unit of data access. Mirrors the request
 * {@link StoreTarget} (authenticated | demo | local) minus `unauthenticated`
 * — which denotes the ABSENCE of a principal and therefore no store — plus
 * `system` for non-request access (cron, scripts, migrations) that brings its
 * own database coordinates rather than resolving them from a request.
 *
 * The request-resolving variants share their exact shape with `StoreTarget`
 * (via `Exclude`), so a resolved-and-reachable target IS a `Principal` with no
 * conversion.
 */
export type Principal =
  | Exclude<StoreTarget, { kind: "unauthenticated" }>
  | { kind: "system"; options: WorthlineStoreOptions };

/**
 * Wrap the shared demo store so a close-after-use cannot tear down the cached
 * instance; it lives for the process and is reused across warm requests (#616,
 * see {@link getDemoStore}). Reads/writes pass straight through.
 */
function withNoopClose(store: WorthlineStore): WorthlineStore {
  return new Proxy(store, {
    get(target, prop, receiver) {
      if (prop === "close") return () => {};
      return Reflect.get(target, prop, receiver);
    },
  });
}

/**
 * Open a store for the given principal. Caller owns the lifecycle (must call
 * `store.close()`), or use {@link withAuthorizedStore} which closes for you.
 */
export async function openAuthorizedStore(principal: Principal): Promise<WorthlineStore> {
  switch (principal.kind) {
    case "authenticated":
      return createWorthlineStoreUnsafe({
        authToken: principal.token,
        url: principal.dbUrl,
      });
    case "demo": {
      const store = await getDemoStore(principal.persona, demoAsOfDateKey(principal.now));
      return withNoopClose(store);
    }
    case "local":
      return createWorthlineStoreUnsafe();
    case "system":
      return createWorthlineStoreUnsafe(principal.options);
  }
}

/**
 * Run a unit of work against a store opened for the given principal, always
 * closing it after (a cached demo store's close is a no-op, so it survives).
 */
export async function withAuthorizedStore<T>(
  principal: Principal,
  run: (store: WorthlineStore) => T | Promise<T>,
  label = "store",
): Promise<T> {
  const startedAt = perfStart();
  const store = await openAuthorizedStore(principal);
  try {
    return await run(store);
  } finally {
    store.close();
    perfEnd(label, startedAt);
  }
}
