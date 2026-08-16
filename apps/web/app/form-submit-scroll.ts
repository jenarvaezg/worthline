/**
 * Pure scroll-restoration logic for form submits (#1296, interaction-patterns §5).
 *
 * Kept in a plain (non-client) module so it is unit-testable in the node
 * environment while the island (`form-submit-scroll-keeper.tsx`) holds only the
 * wiring — the same composition as `active-section.ts` and `view-state.ts` (§3).
 *
 * ## Why this is a loop and not a single frame
 *
 * A validation error is a `redirect()` back to the same pathname with `?error=`.
 * Under Cache Components (#1229) Next hides the outgoing route with React
 * `<Activity>` (`display: none`) the moment the navigation applies, and paints
 * the incoming route a few frames later. In between the document collapses to
 * the height of the chrome alone — measured on journey 31: 1343 px → 535 px.
 *
 * A browser cannot hold a scroll offset a document is too short for, so it
 * clamps it (863 → 55). Restoring inside that window therefore writes a value
 * that is silently clamped away, and the old implementation then had nothing
 * left to retry with: it deleted the saved offset before applying it, in a
 * single `requestAnimationFrame`. Whether the page came back was decided by
 * whether the browser's own scroll anchoring happened to win — which is exactly
 * why journey 31 was green locally and red under CI load.
 *
 * So: wait until the document can actually hold the offset, re-assert it for a
 * bounded window (the router's own scroll-to-top can land after us), and stand
 * down the moment the person scrolls — their intent always outranks the
 * restoration.
 */

/** Saved offset for one form submit. */
export interface SavedScroll {
  pathname: string;
  x: number;
  y: number;
  /** `Date.now()` at save time — see {@link isStaleRecord}. */
  savedAt: number;
}

/**
 * How long a saved offset stays usable. The record is normally consumed by the
 * navigation the submit causes, milliseconds later. A record that outlives this
 * belongs to a submit whose navigation never came back here, and restoring it
 * on some later visit to the same pathname would yank a page the person did not
 * scroll.
 */
export const RECORD_TTL_MS = 10_000;

/** Whether a saved offset is too old to act on. */
export function isStaleRecord(input: { savedAt: number; now: number }): boolean {
  const age = input.now - input.savedAt;
  // A record from the future is a clock change, not a fresh save.
  return age < 0 || age > RECORD_TTL_MS;
}

/** What the DOM looks like right now, as far as this module cares. */
export interface ViewportGeometry {
  /** Current vertical offset. */
  scrollY: number;
  /** The largest offset this document can currently hold. */
  maxScrollY: number;
}

export type RestoreStep =
  /** Write the offset, then keep watching. */
  | { action: "apply"; x: number; y: number }
  /** Cannot (or need not) write this frame; keep watching. */
  | { action: "wait" }
  /** Stop watching and discard the saved offset. */
  | { action: "stop" };

/**
 * How far off target we tolerate before re-asserting. Sub-pixel rounding and
 * the odd 1 px from a scrollbar are not worth a write.
 */
export const SCROLL_TOLERANCE_PX = 2;

/**
 * How long we keep re-asserting once the offset is actually reachable — i.e.
 * measured from the first frame the document is tall enough, NOT from the
 * navigation. Long enough to outlast the router's own scroll-to-top landing
 * after us; short enough that we stop touching a settled page quickly.
 */
export const RESTORE_WINDOW_MS = 1_000;

/**
 * How long we are willing to wait for the incoming route to paint before
 * giving up entirely.
 *
 * This is the budget that has to absorb a loaded machine. Splitting it from
 * RESTORE_WINDOW_MS is the point: a single window measured from the navigation
 * would have to be generous enough for the slowest CI runner, and would then
 * keep re-asserting for just as long on a fast one. Here the slow case only
 * spends its budget waiting — no writes, no fighting — and the re-assert window
 * stays short in every case. Journey 31 paints in ~250 ms locally; CI failures
 * on this route family have stretched past 5 s (#1351).
 */
export const PAINT_WAIT_BUDGET_MS = 8_000;

/**
 * Keys that scroll the page. A validation error lands the person back on the
 * form, so they may well start typing straight away — and typing is not a
 * reason to abandon the restoration. Only keys that actually move the viewport
 * count as taking the scroll into their own hands.
 */
const SCROLLING_KEYS = new Set([
  " ",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "End",
  "Home",
  "PageDown",
  "PageUp",
  "Spacebar",
]);

/**
 * Whether a keystroke means the person is scrolling.
 *
 * A scrolling key pressed inside a text field is editing, not scrolling
 * (`ArrowDown` moves the caret), so an editable target never counts.
 */
export function isUserScrollKey(input: {
  key: string;
  targetIsEditable: boolean;
}): boolean {
  if (input.targetIsEditable) return false;
  return SCROLLING_KEYS.has(input.key);
}

/** Whether an event target edits text, and so swallows the scrolling keys. */
export function isEditableTarget(input: {
  tagName: string | null;
  isContentEditable: boolean;
}): boolean {
  if (input.isContentEditable) return true;
  const tag = (input.tagName ?? "").toLowerCase();
  return tag === "input" || tag === "textarea" || tag === "select";
}

/** Whether a submit event is one whose scroll offset is worth saving. */
export function shouldSaveScroll(input: {
  method: string;
  scrollX: number;
  scrollY: number;
}): boolean {
  // `method="dialog"` closes a <dialog>; it never navigates.
  if (input.method.toLowerCase() === "dialog") return false;
  // Nothing to restore from the top of the page.
  return input.scrollX !== 0 || input.scrollY !== 0;
}

/** Parse a persisted record, tolerating anything that is not one. */
export function parseSavedScroll(raw: string | null): SavedScroll | null {
  if (!raw) return null;
  try {
    const saved = JSON.parse(raw) as Partial<SavedScroll>;
    return typeof saved.pathname === "string" &&
      typeof saved.x === "number" &&
      typeof saved.y === "number" &&
      typeof saved.savedAt === "number"
      ? { pathname: saved.pathname, x: saved.x, y: saved.y, savedAt: saved.savedAt }
      : null;
  } catch {
    return null;
  }
}

/** Whether the document can currently hold the saved offset. */
export function canHoldOffset(input: {
  target: SavedScroll;
  geometry: ViewportGeometry;
}): boolean {
  return input.geometry.maxScrollY >= input.target.y - SCROLL_TOLERANCE_PX;
}

/**
 * Decide what the restore loop should do this frame.
 *
 * The order of the guards is the contract:
 *   1. an interruption ends it, always — the person scrolling by wheel, touch,
 *      or a scrolling key;
 *   2. a document too short to hold the offset is waited on, never written to
 *      (the write would be clamped and we would mistake the clamp for defeat),
 *      until the paint budget runs out;
 *   3. once reachable, the re-assert window runs on its own clock;
 *   4. sitting on target is not "done" — the router's scroll-to-top can still
 *      land after us, so we keep watching until that window closes.
 *
 * @param elapsedMs           since the navigation.
 * @param reachableElapsedMs  since the offset first became reachable, or null
 *                            if the document has never been tall enough.
 */
export function decideRestoreStep(input: {
  target: SavedScroll;
  geometry: ViewportGeometry;
  elapsedMs: number;
  reachableElapsedMs: number | null;
  interrupted: boolean;
  windowMs?: number;
  paintBudgetMs?: number;
}): RestoreStep {
  const { target, geometry, elapsedMs, reachableElapsedMs, interrupted } = input;
  const windowMs = input.windowMs ?? RESTORE_WINDOW_MS;
  const paintBudgetMs = input.paintBudgetMs ?? PAINT_WAIT_BUDGET_MS;

  if (interrupted) return { action: "stop" };

  if (!canHoldOffset({ target, geometry })) {
    return elapsedMs >= paintBudgetMs ? { action: "stop" } : { action: "wait" };
  }

  if (reachableElapsedMs !== null && reachableElapsedMs >= windowMs) {
    return { action: "stop" };
  }
  if (Math.abs(geometry.scrollY - target.y) <= SCROLL_TOLERANCE_PX) {
    return { action: "wait" };
  }
  return { action: "apply", x: target.x, y: target.y };
}
