/**
 * The committed synthetic captures of the golden set, pinned to the exact PNG each one
 * must be. `scripts/generate-extractor-synthetic-fixture.ts` renders them — it owns the
 * render viewports, its own concern, and cannot import across zones (#361) — while
 * `manifest.test.ts` checks the committed bytes against this list, so a capture cannot
 * drift from its HTML source without someone deciding to.
 */
export interface SyntheticFixtureSpec {
  id: string;
  /**
   * Exact PNG size the committed capture must have. It is not the render viewport: the
   * screenshot is the `.frame` element, so a 1px border widens it and a frame shorter
   * than the viewport ends up shorter. Editing an HTML source means updating this.
   */
  capture: { height: number; width: number };
}

export const SYNTHETIC_FIXTURE_SPECS: readonly SyntheticFixtureSpec[] = [
  { capture: { height: 642, width: 822 }, id: "synthetic-baseline" },
  { capture: { height: 760, width: 420 }, id: "synthetic-payment-screen" },
  { capture: { height: 522, width: 762 }, id: "synthetic-amortization-schedule" },
];

/**
 * A blank, black or truncated PNG of the right size compresses to a couple of KB,
 * while the real captures weigh 44-58 KB. The floor is what stops a negative case —
 * which passes precisely when the model recognizes nothing — from grading green
 * against an empty image.
 */
export const MIN_SYNTHETIC_CAPTURE_BYTES = 8 * 1024;

export function syntheticFixtureSpec(id: string): SyntheticFixtureSpec | undefined {
  return SYNTHETIC_FIXTURE_SPECS.find((spec) => spec.id === id);
}
