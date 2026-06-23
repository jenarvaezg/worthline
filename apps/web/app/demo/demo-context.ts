import { DEFAULT_PERSONA, type PersonaId } from "@web/demo/persona";

import type { StoreTarget } from "@web/store-resolver";

/**
 * The demo context (PRD #297, ADR 0030). A pure projection of the resolved
 * request {@link StoreTarget} into `{ enabled, now, persona }` — the shape the
 * write guard, the banner, and the presentation layer query for "are we in the
 * demo, as of when, as whom". Demo-ness is no longer a deploy-wide env flag; it
 * is a per-request state (the persona cookie), decided once in the store seam.
 *
 * Kept free of `next/headers` so it stays a pure unit — the server adapter that
 * actually resolves the target lives in `./read-demo-context`.
 */

/** Cookie carrying the selected persona, mirroring the `wl_scope` cookie. */
export const DEMO_PERSONA_COOKIE_NAME = "wl_demo_persona";

export interface DemoContext {
  /** Whether this request is the read-only demo (a logged-out persona). */
  enabled: boolean;
  /**
   * The demo's "now" as an ISO-8601 string or YYYY-MM-DD date-key. Only
   * meaningful when `enabled`; empty means the demo clock uses the real date
   * (the default — the demo seeds relative to "now", so it stays current).
   */
  now: string;
  /** The persona to render — always a valid id, defaulting to familia. */
  persona: PersonaId;
}

/** Project a resolved store target into the demo context. */
export function demoContextFromTarget(target: StoreTarget): DemoContext {
  if (target.kind === "demo") {
    return { enabled: true, now: target.now, persona: target.persona };
  }
  return { enabled: false, now: "", persona: DEFAULT_PERSONA };
}
