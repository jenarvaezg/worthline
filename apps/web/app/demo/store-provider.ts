/**
 * Demo store provider (PRD #297, ADR 0029). The centralized store-opening seam
 * for demo mode: it opens a per-persona SQLite database in the platform's
 * writable temp dir, so the app's involuntary writes (bootstrap healthcheck,
 * auto-snapshot capture per ADR 0008, price-cache upsert) land on a throwaway
 * copy and a bundled fixture is never mutated.
 *
 * Two sources for that copy, in order:
 *   1. A fixture bundled at build time (S4) under `WORTHLINE_DEMO_FIXTURE_DIR`,
 *      copied into temp — the fast production path.
 *   2. Lazily seeded via {@link seedPersona} when no fixture is bundled — the
 *      zero-config dev path (run locally with `DEMO=1`).
 *
 * The temp copy is memoized per persona per process, so the seed/copy cost is
 * paid once on a warm serverless instance.
 */
import { copyFileSync, existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createWorthlineStore, type WorthlineStore } from "@worthline/db";

import type { PersonaId } from "@web/demo/persona";
import { seedPersona } from "@web/demo/seed-persona";
import { specForPersona } from "@web/demo/specs";

/** Memoized temp-copy paths, one per persona, for the life of the process. */
const storePaths = new Map<PersonaId, string>();

/** The bundled fixture path for a persona, if a fixture dir is configured. */
function bundledFixturePath(persona: PersonaId): string | null {
  const dir = process.env.WORTHLINE_DEMO_FIXTURE_DIR;
  return dir ? join(dir, `${persona}.sqlite`) : null;
}

/**
 * Resolve (creating once) the writable temp database path for `persona`. Copies a
 * bundled fixture when one exists; otherwise seeds a fresh database relative to
 * `asOf` (YYYY-MM-DD, the pinned demo clock).
 */
export function getDemoStorePath(persona: PersonaId, asOf: string): string {
  const cached = storePaths.get(persona);
  if (cached) return cached;

  const dir = mkdtempSync(join(tmpdir(), "worthline-demo-"));
  const target = join(dir, `${persona}.sqlite`);

  const fixture = bundledFixturePath(persona);
  if (fixture && existsSync(fixture)) {
    copyFileSync(fixture, target);
  } else {
    const store = createWorthlineStore({ databasePath: target });
    try {
      seedPersona(store, specForPersona(persona), asOf);
    } finally {
      store.close();
    }
  }

  storePaths.set(persona, target);
  return target;
}

/** Open the persona's writable demo store. Caller owns the lifecycle (close). */
export function openDemoStore(persona: PersonaId, asOf: string): WorthlineStore {
  return createWorthlineStore({ databasePath: getDemoStorePath(persona, asOf) });
}

/** Test-only: drop the memoized temp copies so a fresh fixture is resolved. */
export function resetDemoStoreCache(): void {
  storePaths.clear();
}
