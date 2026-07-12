export const COVER_COUNTER_DELAY_MS = 420;
export const COVER_COUNTER_DURATION_MS = 520;
export const COVER_COMPOSITION_DELAY_MS = 260;

export type LandingMotionState = "pending" | "playing" | "final";

export type LandingMotionEvent =
  | { type: "ready"; reducedMotion: boolean }
  | { type: "preference-changed"; reducedMotion: boolean };

/** Pure policy: mounting starts motion once; reducing motion always settles final. */
export function transitionLandingMotion(
  state: LandingMotionState,
  event: LandingMotionEvent,
): LandingMotionState {
  if (event.type === "ready" && state === "pending") {
    return event.reducedMotion ? "final" : "playing";
  }
  if (event.type === "preference-changed" && event.reducedMotion) return "final";
  return state;
}

export function coverStageDelay(stage: number): number {
  return 40 + stage * 80;
}

export function formatLandingNet(value: number): string {
  return `${value.toLocaleString("es-ES")} €`;
}

export function nextTypedCharacterCount(current: number, length: number): number {
  return Math.min(current + 1, length);
}

export function hasAuthenticatedSession(value: unknown): boolean {
  if (!value || typeof value !== "object" || !("user" in value)) return false;
  return value.user !== null && typeof value.user === "object";
}
