/**
 * Persona spec registry. Maps each persona id to its declarative spec. familia
 * (S1) ships first; joven and inversor (S3) are added here as they land. The
 * store provider resolves a persona's spec through {@link specForPersona}, which
 * falls back to the familia spec for any persona without one yet — the demo must
 * always render something.
 */
import type { PersonaId } from "@web/demo/persona";
import type { PersonaSpec } from "@web/demo/spec-types";
import { FAMILIA_SPEC } from "@web/demo/specs/familia";
import { INVERSOR_SPEC } from "@web/demo/specs/inversor";
import { JOVEN_SPEC } from "@web/demo/specs/joven";

export const PERSONA_SPECS: Record<PersonaId, PersonaSpec> = {
  familia: FAMILIA_SPEC,
  inversor: INVERSOR_SPEC,
  joven: JOVEN_SPEC,
};

export function specForPersona(persona: PersonaId): PersonaSpec {
  return PERSONA_SPECS[persona];
}
