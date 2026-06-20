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
      "Primeros años de carrera: caja, fondo de emergencia, primera cartera, ahorro bloqueado y un préstamo educativo.",
  },
  inversor: {
    id: "inversor",
    label: "Inversor",
    pitch:
      "Cartera con aportaciones, ventas, reserva fiscal, pensión, Numista, Binance y progreso FIRE visible.",
  },
  familia: {
    id: "familia",
    label: "Familia",
    pitch:
      "Hogar con vivienda, hipoteca, amortizaciones, préstamo de coche, reparto de propiedad y escalera completa.",
  },
};
