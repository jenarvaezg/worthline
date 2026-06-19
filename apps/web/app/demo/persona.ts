/**
 * Demo personas (PRD #297, ADR 0029). A persona is a curated, fictional
 * workspace the demo build seeds and renders. The id vocabulary is closed and
 * lives here — the single source of truth queried by the demo context resolver,
 * the store provider, the seed specs, and the /demo landing.
 */

/** Order is the /demo landing order: starter → markets → household. */
export const PERSONA_IDS = ["joven", "inversor", "familia"] as const;

export type PersonaId = (typeof PERSONA_IDS)[number];

/**
 * The cold-visit default. familia is the richest story (two members, a home and
 * mortgage, the full five-rung ladder, scope switching), so an empty cookie
 * always lands on something feature-complete.
 */
export const DEFAULT_PERSONA: PersonaId = "familia";

export function isPersonaId(value: unknown): value is PersonaId {
  return typeof value === "string" && (PERSONA_IDS as readonly string[]).includes(value);
}

/**
 * Parse an arbitrary cookie/query value to a PersonaId, falling back to the
 * default persona for anything unknown or absent. An unknown persona never
 * errors — the demo must always render something.
 */
export function parsePersonaId(value: string | null | undefined): PersonaId {
  return isPersonaId(value) ? value : DEFAULT_PERSONA;
}

export interface PersonaMeta {
  id: PersonaId;
  /** Short display label, e.g. "Familia". */
  label: string;
  /** One-line pitch shown on the /demo landing. */
  pitch: string;
}

/** Display copy for the /demo landing. Pure data — no behaviour. */
export const PERSONA_META: Record<PersonaId, PersonaMeta> = {
  joven: {
    id: "joven",
    label: "Joven",
    pitch:
      "Alguien que empieza a ahorrar: casi todo en caja, una primera inversión pequeña, sin vivienda ni deuda.",
  },
  inversor: {
    id: "inversor",
    label: "Inversor",
    pitch:
      "Cartera de mercado con fondos, acciones y cripto, un plan de pensiones a plazo, una fuente conectada y progreso FIRE.",
  },
  familia: {
    id: "familia",
    label: "Familia",
    pitch:
      "Un hogar de dos miembros con vivienda habitual, hipoteca, reparto de propiedad y la escalera de liquidez completa.",
  },
};
