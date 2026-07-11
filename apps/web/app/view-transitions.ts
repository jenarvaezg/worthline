/**
 * Pure transition-eligibility logic (#517, interaction-patterns §5, ADR 0036).
 *
 * Determines whether a navigation between two pathnames should be animated via
 * the View Transitions API and what CSS `transitionTypes` to request.  Kept in
 * a plain (non-client) module so it is unit-testable in the node environment
 * while the client island (or the Next 16 automatic routing) holds only the
 * thin wiring — the same pattern as `view-state.ts` (§3) and
 * `composition-chart-hover.ts` (§7).
 *
 * Graceful degradation: callers check `supportsViewTransitions()` before
 * triggering any transition.  When the browser does not support the API the
 * navigation falls back to normal Next routing — never a broken half-transition.
 *
 * `prefers-reduced-motion`: the CSS layer handles this (globals.css already
 * zeros animation/transition durations for reduced-motion users), so the
 * eligibility logic here does NOT need to duplicate that check — it would only
 * know the preference at runtime inside a `"use client"` module, while CSS
 * applies it unconditionally and earlier.
 */

/** The top-level section paths — used to classify navigation direction. */
const TOP_SECTIONS = ["/app", "/patrimonio", "/historico", "/ajustes"] as const;

export type TopSection = (typeof TOP_SECTIONS)[number];

/** Navigation type token passed as a CSS `view-transition-type` selector hint. */
export type TransitionType =
  | "cross-fade" // default: fade between any two surfaces
  | "slide-forward" // moving to a "deeper" section in the nav order
  | "slide-back"; // moving to an "earlier" section in the nav order

/** Result from `classifyTransition`. */
export interface TransitionClassification {
  /** Whether a View Transition animation should be applied at all. */
  eligible: boolean;
  /** CSS transition-type tokens to pass to `router.push({ transitionTypes })`. */
  transitionTypes: TransitionType[];
}

/**
 * The nav-order index of a pathname, or -1 if it is not a top-level section.
 * Sub-paths (e.g. `/patrimonio/abc/editar`) inherit the section's index.
 */
function sectionIndex(pathname: string): number {
  // Exact match first (covers `/app`).
  const exact = TOP_SECTIONS.indexOf(pathname as TopSection);
  if (exact !== -1) return exact;

  // Prefix match for sub-paths (longest prefix wins).
  const sorted = [...TOP_SECTIONS].sort((a, b) => b.length - a.length);
  for (const section of sorted) {
    if (pathname.startsWith(section)) {
      return TOP_SECTIONS.indexOf(section);
    }
  }

  return -1;
}

/**
 * Classify the navigation from `fromPathname` to `toPathname` and return the
 * transition type tokens to request from React.
 *
 * Rules:
 * - Same effective pathname → not eligible (no animation for a no-op nav).
 * - Both pathnames are top-level sections (or sub-paths of one) → slide
 *   forward/back based on nav order.
 * - Any other cross-surface navigation → cross-fade.
 * - The drill open/close within the dashboard is NOT a route navigation; it is
 *   a client-state toggle handled by the island (S4 #520) and therefore falls
 *   outside this module's scope.
 */
export function classifyTransition(
  fromPathname: string,
  toPathname: string,
): TransitionClassification {
  if (fromPathname === toPathname) {
    return { eligible: false, transitionTypes: [] };
  }

  const fromIdx = sectionIndex(fromPathname);
  const toIdx = sectionIndex(toPathname);

  if (fromIdx !== -1 && toIdx !== -1 && fromIdx !== toIdx) {
    const type: TransitionType = toIdx > fromIdx ? "slide-forward" : "slide-back";
    return { eligible: true, transitionTypes: [type] };
  }

  // Cross-fade for all other navigations (e.g. sub-page → top section).
  return { eligible: true, transitionTypes: ["cross-fade"] };
}

/**
 * Whether the current browser runtime supports the View Transitions API.
 * Always returns `false` in non-browser environments (SSR/node), providing
 * the graceful-degradation path without requiring try/catch at each call site.
 */
export function supportsViewTransitions(): boolean {
  return typeof document !== "undefined" && "startViewTransition" in document;
}
