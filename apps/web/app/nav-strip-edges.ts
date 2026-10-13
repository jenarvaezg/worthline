/**
 * Which edges of the section strip hide something (#1723, canon §5).
 *
 * The strip (`.topbarEnd`: the five tabs plus «Cerrar sesión») scrolls
 * horizontally with its scrollbar hidden, so nothing on screen says there is
 * more. The island (`nav-strip.tsx`) reads the strip's geometry, asks this
 * module which edges hide content, and the CSS fades exactly those edges.
 *
 * Kept in a plain (non-client) module so it is unit-testable in the node
 * environment while the island holds only the wiring — the same composition as
 * `form-submit-scroll.ts` and `form-submit-scroll-keeper.tsx`.
 */

/** Which edges of the strip hide something. */
export type StripOverflow = "none" | "start" | "end" | "both";

/** The three measures the verdict reads — an `HTMLElement` satisfies it as is. */
export interface StripGeometry {
  scrollLeft: number;
  scrollWidth: number;
  clientWidth: number;
}

/**
 * Below this many pixels an edge counts as flush. Browsers round `scrollLeft`
 * and the widths independently, so a strip that fits can report 1px of
 * overflow, and one scrolled to its end can report a fractional remainder.
 */
const SUBPIXEL_TOLERANCE_PX = 1;

export function stripOverflow(geometry: StripGeometry): StripOverflow {
  const hiddenStart = geometry.scrollLeft > SUBPIXEL_TOLERANCE_PX;
  const hiddenEnd =
    geometry.scrollWidth - geometry.clientWidth - geometry.scrollLeft >
    SUBPIXEL_TOLERANCE_PX;

  if (hiddenStart && hiddenEnd) return "both";
  if (hiddenStart) return "start";
  if (hiddenEnd) return "end";
  return "none";
}
