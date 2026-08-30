/**
 * Re-scoping the unified add form to the canonical names the parsers expect
 * (#1611, extracted from `createHoldingAction`).
 *
 * Every instrument's pane is in the DOM at once — the disclosure is pure CSS
 * (ADR 0009) — so every pane POSTS, and each field is suffixed with its own
 * instrument (`name_fund`, `name_mortgage`…) to keep them from colliding. The
 * ownership footer is the exception: it is shared, so it posts unsuffixed.
 *
 * These two helpers are all the families share of that mechanics. Each family
 * builds its OWN scoped form out of them, reading only the fields its pane posts
 * — which is what keeps adding a field to one pane from touching the others.
 */

/** The field every alta pane posts, whatever the instrument. */
export const SHARED_REFILL_FIELDS: readonly string[] = ["name"];

/** Copy a suffixed field onto a canonical name, when present. */
export function carry(
  from: FormData,
  to: FormData,
  sourceKey: string,
  canonicalKey: string,
): void {
  const value = from.get(sourceKey);
  if (value !== null) {
    to.set(canonicalKey, String(value));
  }
}

/** Copy the shared ownership fields (canonical, not suffixed) onto the scoped form. */
export function carryOwnership(from: FormData, to: FormData): void {
  for (const [key, value] of from.entries()) {
    if (
      key === "ownershipPreset" ||
      key === "scopeMemberId" ||
      key.startsWith("owner_")
    ) {
      to.set(key, String(value));
    }
  }
}
