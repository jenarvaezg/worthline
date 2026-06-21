/**
 * The web-level store seam (PRD #297, ADR 0029, ADR 0030). One place that
 * resolves the three request states (ADR 0030):
 *   - authenticated → the user's own workspace (libSQL URL + group token);
 *   - demo → an ephemeral in-memory libSQL database seeded per request from the
 *     persona specs, memoized once per request and discarded after the response
 *     ("nothing the viewer does persists" by construction);
 *   - local → the env-configured single-user store (no-auth dev / tests).
 * Every read page and read route opens its store through here, so the behavior
 * lives in one seam rather than scattered across pages.
 */
import { cache } from "react";

import {
  createWorthlineStore,
  runBootstrapHealthcheck,
  type WorthlineStore,
} from "@worthline/db";
import type { LocalPersistenceStatus } from "@worthline/domain";

import { demoAsOfDateKey, demoNowDate } from "@web/demo/demo-clock";
import type { PersonaId } from "@web/demo/persona";
import { seedDemoStore } from "@web/demo/store-provider";

import { readStoreTarget } from "./read-store-target";
import type { StoreTarget } from "./store-resolver";

// Re-exported so request-scoped callers (pages, server actions) import both the
// store opener and its type from this seam — never from `@worthline/db` directly,
// whose `withStore` defaults to the local file path (ENOENT on Vercel's read-only
// FS) instead of resolving the authenticated workspace / demo target (ADR 0030).
export type { WorthlineStore } from "@worthline/db";

function assertReachable(target: StoreTarget): void {
  if (target.kind === "unauthenticated") {
    throw new Error("Store opened without authentication");
  }
}

/**
 * One seeded in-memory demo store per request. React's `cache` memoizes for the
 * lifetime of a single server request, so however many times a page opens the
 * store, the persona is seeded once; the store is dropped (and GC'd) once the
 * response is sent. Keyed by persona + pinned day so a persona switch re-seeds.
 */
const requestDemoStore = cache(
  (persona: PersonaId, asOf: string): Promise<WorthlineStore> =>
    seedDemoStore(persona, asOf),
);

/**
 * Wrap the per-request demo store so `withStore`'s close-after-use cannot tear
 * down the shared instance mid-request; the real store is discarded by GC after
 * the response. Reads/writes pass straight through.
 */
function withNoopClose(store: WorthlineStore): WorthlineStore {
  return new Proxy(store, {
    get(target, prop, receiver) {
      if (prop === "close") return () => {};
      return Reflect.get(target, prop, receiver);
    },
  });
}

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

/** Bootstrap healthcheck — pinned to the authenticated workspace or demo clock. */
export async function bootstrapHealthcheck(
  target?: StoreTarget,
): Promise<LocalPersistenceStatus> {
  const resolved = target ?? (await readStoreTarget());
  assertReachable(resolved);

  if (resolved.kind === "authenticated") {
    return runBootstrapHealthcheck({
      authToken: resolved.token,
      url: resolved.dbUrl,
    });
  }

  if (resolved.kind === "demo") {
    return demoHealthcheck(resolved.now);
  }

  return runBootstrapHealthcheck();
}

/** Open a store. Caller owns the lifecycle (must call `store.close()`). */
export async function openStore(target?: StoreTarget): Promise<WorthlineStore> {
  const resolved = target ?? (await readStoreTarget());
  assertReachable(resolved);

  if (resolved.kind === "authenticated") {
    return createWorthlineStore({
      authToken: resolved.token,
      url: resolved.dbUrl,
    });
  }

  if (resolved.kind === "demo") {
    const store = await requestDemoStore(resolved.persona, demoAsOfDateKey(resolved.now));
    return withNoopClose(store);
  }

  return createWorthlineStore();
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
