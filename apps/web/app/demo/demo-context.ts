import { DEFAULT_PERSONA, parsePersonaId, type PersonaId } from "@web/demo/persona";

/**
 * The demo context resolver (PRD #297, ADR 0023). A pure function that derives
 * `{ enabled, now, persona }` from the environment and the persona cookie. It is
 * the single source of truth queried by the store provider, the write guard, and
 * the presentation layer for "are we in demo mode, as of when, as whom".
 *
 * Kept free of `next/headers` so it stays a pure unit — the server adapter that
 * actually reads `cookies()` lives in `./read-demo-context`.
 */

/** Cookie carrying the selected persona, mirroring the `wl_scope` cookie. */
export const DEMO_PERSONA_COOKIE_NAME = "wl_demo_persona";

export interface DemoContext {
  /** Whether the build is running as the read-only demo. */
  enabled: boolean;
  /**
   * The pinned "now" as the raw `WORTHLINE_DEMO_NOW` value (an ISO-8601 string or
   * YYYY-MM-DD date-key). Only meaningful when `enabled`; empty when unset.
   */
  now: string;
  /** The persona to render — always a valid id, defaulting to familia. */
  persona: PersonaId;
}

export interface ResolveDemoContextInput {
  /** Raw `process.env.DEMO`. */
  demoFlag?: string | undefined;
  /** Raw `process.env.WORTHLINE_DEMO_NOW`. */
  demoNow?: string | undefined;
  /** Raw value of the `wl_demo_persona` cookie. */
  personaCookie?: string | null | undefined;
}

/** A flag is "on" unless it is absent or an explicit off value. */
function isDemoFlagOn(flag: string | undefined): boolean {
  if (flag === undefined) return false;
  const normalized = flag.trim().toLowerCase();
  return (
    normalized !== "" &&
    normalized !== "0" &&
    normalized !== "false" &&
    normalized !== "off"
  );
}

export function resolveDemoContext(input: ResolveDemoContextInput = {}): DemoContext {
  if (!isDemoFlagOn(input.demoFlag)) {
    return { enabled: false, now: "", persona: DEFAULT_PERSONA };
  }

  return {
    enabled: true,
    now: (input.demoNow ?? "").trim(),
    persona: parsePersonaId(input.personaCookie),
  };
}
