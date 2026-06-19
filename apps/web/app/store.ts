/**
 * The web-level store seam (PRD #297, ADR 0023). One place that decides
 * demo-vs-live: in demo mode it opens the persona's writable temp copy and pins
 * the healthcheck clock; otherwise it behaves exactly like the underlying
 * `@worthline/db` helpers. Every read page and read route opens its store through
 * here, so demo behavior lives in one seam rather than scattered across pages.
 *
 * With `DEMO` unset, `readDemoContext` short-circuits before any cookie read and
 * these delegate straight to the live `createWorthlineStore` / `withStore` /
 * `runBootstrapHealthcheck`, so the live build is unaffected.
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

/** Bootstrap healthcheck — pinned to the demo clock and temp copy in demo mode. */
export async function bootstrapHealthcheck(): Promise<LocalPersistenceStatus> {
  const demo = await readDemoContext();
  if (!demo.enabled) {
    return runBootstrapHealthcheck();
  }

  const asOf = demoAsOfDateKey(demo.now);
  return runBootstrapHealthcheck({
    databasePath: getDemoStorePath(demo.persona, asOf),
    now: () => demoNowDate(demo.now),
  });
}

/** Open a store. Caller owns the lifecycle (must call `store.close()`). */
export async function openStore(): Promise<WorthlineStore> {
  const demo = await readDemoContext();
  if (!demo.enabled) {
    return createWorthlineStore();
  }
  return openDemoStore(demo.persona, demoAsOfDateKey(demo.now));
}

/** Run a unit of work against a freshly opened store, always closing it after. */
export async function withStore<T>(
  run: (store: WorthlineStore) => T | Promise<T>,
): Promise<T> {
  const store = await openStore();
  try {
    return await run(store);
  } finally {
    store.close();
  }
}
