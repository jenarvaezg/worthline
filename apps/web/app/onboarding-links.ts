import type { OnboardingStepId } from "@worthline/domain";

/**
 * Where each first-steps checklist entry sends the user (#1702).
 *
 * Two rules, both learned the hard way. Every destination lives inside the
 * authenticated area: `/` is the public landing since the marketing split, so
 * a logged-in user who taps a checklist step must never end up there. And the
 * map is keyed by the closed `OnboardingStepId` union rather than by `string`,
 * so a new step is a type error here instead of silently falling back to a
 * default destination.
 *
 * `null` marks a step with nothing to press: the checklist renders it as plain
 * text. A link is a promise that the page on the other side helps, and a step
 * that is still pending precisely because the data does not exist yet cannot
 * keep that promise.
 */
export const ONBOARDING_LINKS: Record<OnboardingStepId, string | null> = {
  members: "/ajustes",
  holdings: "/patrimonio/anadir",
  // Los supuestos FIRE se editan junto a sus cifras desde #1450.
  fire: "/objetivos#supuestos",
  // El snapshot lo captura el cron: no hay acción de usuario, y el histórico
  // está vacío justo mientras este paso sigue pendiente.
  snapshot: null,
};
