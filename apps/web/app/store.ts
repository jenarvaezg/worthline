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
 */

import { demoAsOfDateKey, demoNowDate } from "@web/demo/demo-clock";
import { getDemoStore } from "@web/demo/store-provider";
import {
  createWorthlineStore,
  runBootstrapHealthcheck,
  type WorthlineStore,
} from "@worthline/db";
import type { LocalPersistenceStatus } from "@worthline/domain";

import { perfEnd, perfStart } from "./perf-log";
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
 * Wrap the shared demo store so `withStore`'s close-after-use cannot tear down
 * the cached instance; it lives for the process and is reused across warm
 * requests (#616, see {@link getDemoStore}). Reads/writes pass straight through.
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

/**
 * Synthesize the persistence status for an authenticated workspace WITHOUT a DB
 * round-trip (#445). The footer only renders `displayPath` + a render-time
 * "guardado" stamp and nothing branches on a real write, so probing the remote
 * workspace DB on every page render — a separate connection plus a write that no
 * reader consumes — was pure overhead. A genuinely unreachable or read-only
 * workspace still surfaces: read pages fail fast at `withStore()`, and writes
 * fail at the action that writes (with a proper error) instead of the old
 * behavior where a failed probe-write threw and bricked even read-only pages.
 */
function workspaceHealthcheck(dbUrl: string): LocalPersistenceStatus {
  const checkedAt = new Date().toISOString();
  return {
    status: "ok",
    checkKey: "bootstrap.last_healthcheck_at",
    checkedAt,
    checkValue: checkedAt,
    databasePath: dbUrl,
    displayPath: dbUrl,
  };
}

/** Bootstrap healthcheck — pinned to the authenticated workspace or demo clock. */
export async function bootstrapHealthcheck(
  target?: StoreTarget,
): Promise<LocalPersistenceStatus> {
  const resolved = target ?? (await readStoreTarget());
  assertReachable(resolved);

  if (resolved.kind === "authenticated") {
    // Synthesize instead of probing the remote workspace DB on every render
    // (#445) — no per-pageview write, no second connection. See workspaceHealthcheck.
    return workspaceHealthcheck(resolved.dbUrl);
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
    const store = await getDemoStore(resolved.persona, demoAsOfDateKey(resolved.now));
    return withNoopClose(store);
  }

  return createWorthlineStore();
}

/** Run a unit of work against a freshly opened store, always closing it after. */
export async function withStore<T>(
  run: (store: WorthlineStore) => T | Promise<T>,
  target?: StoreTarget,
  label = "store",
): Promise<T> {
  const startedAt = perfStart();
  const store = await openStore(target);
  try {
    return await run(store);
  } finally {
    store.close();
    perfEnd(label, startedAt);
  }
}
