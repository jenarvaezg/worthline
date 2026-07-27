/**
 * Public holding ids (`wl_hld_…`) as they appear in text and in tool payloads.
 *
 * Its own module because three rules need the same primitive and must not be able to
 * disagree about what an id is: the write-path provenance gate
 * (`holding-id-provenance.ts`), the render rule that keeps ids out of prose
 * (`holding-id-prose.ts`) and the bound on a proposal's headline
 * (`proposal-summary.ts`), all from #1263. Two run on the server and one in the
 * browser; what they share is these 39 characters and nothing else.
 */

import { walkDeep } from "./walk-deep";

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
 * A walk rather than a scan of `JSON.stringify`: tool payloads are JSON-shaped in
 * practice, but a serializer that throws (a cycle, a `BigInt`) would turn a
 * bookkeeping detail into a dead chat turn.
 */
export function publicHoldingIdsIn(value: unknown): string[] {
  const found: string[] = [];
  walkDeep(value, (_key, nested) => {
    if (typeof nested !== "string") return;
    for (const match of nested.matchAll(PUBLIC_HOLDING_ID)) found.push(match[0]);
  });
  return [...new Set(found)];
}

/**
 * Replace every id-looking token in a text, well-formed or not.
 *
 * Adjacent backticks are eaten with the token: models write ids as inline code, and
 * a name left inside code fences reads like a fragment of machinery rather than the
 * holding it now names.
 */
/**
 * What stands in for an id that cannot be named: no accusation, no machinery. It is
 * also what a half-typed id becomes for a moment while an answer streams, so it has
 * to read as ordinary parenthetical prose.
 */
export const UNNAMED_HOLDING = "(identificador interno)";

export function replacePublicHoldingIdLookalikes(
  text: string,
  replace: (token: string) => string,
): string {
  return text.replace(
    new RegExp(`\`?${PUBLIC_HOLDING_ID_LOOKALIKE.source}\`?`, "gi"),
    (match) => replace(match.replaceAll("`", "")),
  );
}
