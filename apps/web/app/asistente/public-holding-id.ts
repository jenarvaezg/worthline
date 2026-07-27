/**
 * Public holding ids (`wl_hld_…`) as they appear in text and in tool payloads.
 *
 * Its own module because two rules need the same primitive and must not be able to
 * disagree about what an id is: the write-path provenance gate
 * (`holding-id-provenance.ts`) and the render rule that keeps ids out of prose
 * (`holding-id-prose.ts`), both from #1263. One runs on the server and the other in
 * the browser; what they share is these 39 characters and nothing else.
 */

/**
 * The shape `createAgentViewPublicId` mints: the prefix plus 32 lowercase hex.
 * Public-id import validation pins the same `^prefix[a-f0-9]{32}$` contract, so
 * anything else is not an id worthline ever produced.
 */
const PUBLIC_HOLDING_ID = /wl_hld_[0-9a-f]{32}/g;

/**
 * Anything WEARING the prefix, well-formed or not — what a human reader would take
 * for an id. Two real cases need it: `wl_hld_mortgage_id_placeholder_need_to_find_it`
 * is what the pool model sent to a write tool (#1263), and a half-typed
 * `wl_hld_3d44` is what the screen holds for a moment while the answer streams.
 * Both are ids as far as the reader is concerned, so both belong to prose.
 */
const PUBLIC_HOLDING_ID_LOOKALIKE = /wl_hld_[a-z0-9_]*/gi;

/** Is this exactly one well-formed public holding id, with nothing around it? */
export function isPublicHoldingId(value: string): boolean {
  return new RegExp(`^${PUBLIC_HOLDING_ID.source}$`).test(value);
}

/**
 * Every well-formed id anywhere inside a value, deduplicated in first-seen order.
 *
 * A recursive walk rather than a scan of `JSON.stringify`: tool payloads are
 * JSON-shaped in practice, but a serializer that throws (a cycle, a `BigInt`) would
 * turn a bookkeeping detail into a dead chat turn. The walk carries the same
 * promise, hence the visited set.
 */
export function publicHoldingIdsIn(value: unknown): string[] {
  const found: string[] = [];
  collectIds(value, found, new WeakSet());
  return [...new Set(found)];
}

function collectIds(value: unknown, into: string[], seen: WeakSet<object>): void {
  if (typeof value === "string") {
    for (const match of value.matchAll(PUBLIC_HOLDING_ID)) into.push(match[0]);
    return;
  }
  if (typeof value !== "object" || value === null || seen.has(value)) return;
  seen.add(value);
  for (const nested of Array.isArray(value) ? value : Object.values(value)) {
    collectIds(nested, into, seen);
  }
}

/**
 * Replace every id-looking token in a text, well-formed or not.
 *
 * Adjacent backticks are eaten with the token: models write ids as inline code, and
 * a name left inside code fences reads like a fragment of machinery rather than the
 * holding it now names.
 */
export function replacePublicHoldingIdLookalikes(
  text: string,
  replace: (token: string) => string,
): string {
  return text.replace(
    new RegExp(`\`?${PUBLIC_HOLDING_ID_LOOKALIKE.source}\`?`, "gi"),
    (match) => replace(match.replaceAll("`", "")),
  );
}
