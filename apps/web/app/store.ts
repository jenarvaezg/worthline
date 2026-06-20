/**
 * The web-level store seam (PRD #297, ADR 0029, ADR 0030). One place that decides
 * demo-vs-live-vs-authenticated: in demo mode it opens the persona's writable
 * temp copy and pins the healthcheck clock; in authenticated mode it opens the
 * user's env-configured workspace; otherwise it behaves exactly like the
 * underlying `@worthline/db` helpers. Every read page and read route opens its
 * store through here, so behavior lives in one seam rather than scattered across
 * pages.
 *
 * With `AUTH_GOOGLE_ID` unset, `readStoreTarget` short-circuits before any
 * session read and these delegate straight to the live `createWorthlineStore` /
 * `withStore` / `runBootstrapHealthcheck`, so the local no-auth build is
 * unaffected.
 */
import {
  createWorthlineStore,
  runBootstrapHealthcheck,
  type WorthlineStore,
} from "@worthline/db";
import type { LocalPersistenceStatus } from "@worthline/domain";

import { demoAsOfDateKey, demoNowDate } from "@web/demo/demo-clock";
import { readDemoContext } from "@web/demo/read-demo-context";
import { getDemoStorePath, openDemoStore } from "@web/demo/store-provider";

import { readStoreTarget } from "./read-store-target";
import type { StoreTarget } from "./store-resolver";

function assertAuthenticated(target: StoreTarget): void {
  if (target.kind === "unauthenticated") {
    throw new Error("Store opened without authentication");
  }
}

/** Bootstrap healthcheck — pinned to the authenticated workspace or demo clock. */
export async function bootstrapHealthcheck(
  target?: StoreTarget,
): Promise<LocalPersistenceStatus> {
  const resolved = target ?? (await readStoreTarget());
  assertAuthenticated(resolved);

  if (resolved.kind === "authenticated") {
    return runBootstrapHealthcheck({
      authToken: resolved.token,
      url: resolved.dbUrl,
    });
  }

  const demo = await readDemoContext();
  if (!demo.enabled) {
    return runBootstrapHealthcheck();
  }

  const asOf = demoAsOfDateKey(demo.now);
  return runBootstrapHealthcheck({
    databasePath: await getDemoStorePath(demo.persona, asOf),
    now: () => demoNowDate(demo.now),
  });
}

/** Open a store. Caller owns the lifecycle (must call `store.close()`). */
export async function openStore(target?: StoreTarget): Promise<WorthlineStore> {
  const resolved = target ?? (await readStoreTarget());
  assertAuthenticated(resolved);

  if (resolved.kind === "authenticated") {
    return createWorthlineStore({
      authToken: resolved.token,
      url: resolved.dbUrl,
    });
  }

  const demo = await readDemoContext();
  if (!demo.enabled) {
    return createWorthlineStore();
  }

  return openDemoStore(demo.persona, demoAsOfDateKey(demo.now));
}

/** Run a unit of work against a freshly opened store, always closing it after. */
export async function withStore<T>(
  run: (store: WorthlineStore) => T | Promise<T>,
  target?: StoreTarget,
): Promise<T> {
  const store = await openStore(target);
  try {
    return await run(store);
  } finally {
    store.close();
  }
}
