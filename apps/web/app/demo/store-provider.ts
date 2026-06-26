/**
 * Demo store provider (PRD #297, ADR 0030). Seeds a persona's workspace into a
 * fresh ephemeral **in-memory libSQL** database. The demo folds into the real
 * deployment as a per-request state: a logged-out request carrying the persona
 * cookie opens one of these, seeded from the persona specs and discarded after
 * the response (ADR 0030 supersedes ADR 0029's bundled-fixture / temp-copy
 * scheme — there is no file to mutate and "nothing the viewer does persists" by
 * construction).
 *
 * Seeding is deterministic and network-free (see {@link seedPersona}); every
 * date is relative to `asOf` (the pinned demo clock), so the history regenerates
 * coherently whenever the demo's "now" moves. The store seam (`@web/store`)
 * memoizes one seeded store per request, so the seed cost is paid once per page
 * load however many times the store is opened.
 */
import { createInMemoryStore, type WorthlineStore } from "@worthline/db";

import type { PersonaId } from "@web/demo/persona";
import { seedPersona } from "@web/demo/seed-persona";
import { specForPersona } from "@web/demo/specs";

/**
 * Create a fresh in-memory store seeded with `persona`'s workspace, with its
 * history generated relative to `asOf` (YYYY-MM-DD). Each call returns an
 * independent database; the caller owns the lifecycle (must call `close()`).
 */
export async function seedDemoStore(
  persona: PersonaId,
  asOf: string,
): Promise<WorthlineStore> {
  const store = await createInMemoryStore();
  await seedPersona(store, specForPersona(persona), asOf);
  return store;
}

/**
 * Per-process cache of seeded demo stores, keyed by persona + as-of day (#616).
 * Demo mode is read-only — every mutating action is short-circuited by
 * `guardDemoWrite` before it ever reaches the store — so one seeded in-memory DB
 * is safely shared across all warm requests for the same persona/date: the seed
 * cost is paid once per process, not once per navigation (the old React
 * per-request cache reseeded on every request). A different persona or day is a
 * different key and seeds its own workspace, so a switch reseeds.
 *
 * ponytail: bounded FIFO (DEMO_STORE_CACHE_MAX). The demo has 3 personas and the
 * day is normally pinned, so this only trims if an unpinned clock drifts across
 * many days; evicted stores are GC'd, not closed (the caller's `close()` is a
 * no-op anyway). Bump the cap or switch to LRU if personas multiply.
 */
const DEMO_STORE_CACHE_MAX = 12;
const demoStores = new Map<string, Promise<WorthlineStore>>();

export function getDemoStore(persona: PersonaId, asOf: string): Promise<WorthlineStore> {
  const key = `${persona}|${asOf}`;
  const cached = demoStores.get(key);
  if (cached) return cached;

  // A failed seed must not poison the key forever — evict so the next request retries.
  const seeded = seedDemoStore(persona, asOf).catch((error: unknown) => {
    demoStores.delete(key);
    throw error;
  });
  demoStores.set(key, seeded);

  if (demoStores.size > DEMO_STORE_CACHE_MAX) {
    const oldest = demoStores.keys().next().value;
    if (oldest !== undefined) demoStores.delete(oldest);
  }
  return seeded;
}
