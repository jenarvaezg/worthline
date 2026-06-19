/**
 * Persona spec registry. Maps each persona id to its declarative spec. familia
 * (S1) ships first; joven and inversor (S3) are added here as they land. The
 * store provider resolves a persona's spec through {@link specForPersona}, which
 * falls back to the familia spec for any persona without one yet — the demo must
 * always render something.
 */
import { DEFAULT_PERSONA, type PersonaId } from "@web/demo/persona";
import type { PersonaSpec } from "@web/demo/spec-types";
import { FAMILIA_SPEC } from "@web/demo/specs/familia";

export const PERSONA_SPECS: Partial<Record<PersonaId, PersonaSpec>> = {
  familia: FAMILIA_SPEC,
};

export function specForPersona(persona: PersonaId): PersonaSpec {
  return PERSONA_SPECS[persona] ?? PERSONA_SPECS[DEFAULT_PERSONA] ?? FAMILIA_SPEC;
}
