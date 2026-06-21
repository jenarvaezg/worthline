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
