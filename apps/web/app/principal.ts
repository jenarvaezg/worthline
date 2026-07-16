/**
 * The authorization port (PRD #998 S1, decision #892 — adopción Sure banda 2).
 *
 * A workspace's data can only be reached by presenting a {@link Principal}:
 * the port's entry points take one BY VALUE, so the old runtime
 * `assertReachable` check ("Store opened without authentication") becomes a
 * COMPILE-TIME guarantee — the `unauthenticated` state is unrepresentable as a
 * `Principal`, so a store cannot be constructed without one.
 *
 * The RSC seam (`store.ts`) reaches a workspace store ONLY through here, so the
 * whole RSC surface starts from a principal. The raw opener lives in
 * `@worthline/db` under a deliberately unsafe name (`createWorthlineStoreUnsafe`)
 * so no surface grabs it by accident; this port is its only authorized wrapper.
 * The other current callers of the unsafe opener — cron, scripts, and the
 * deferred REST v1 routes (tripwire of #892) — still open it directly for now;
 * they migrate onto the `system` principal in a later slice of PRD #998.
 */

import { demoAsOfDateKey } from "@web/demo/demo-clock";
import { getDemoStore } from "@web/demo/store-provider";
import {
  createWorthlineStoreUnsafe,
  type WorthlineStore,
  type WorthlineStoreOptions,
} from "@worthline/db";

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
