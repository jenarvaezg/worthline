/**
 * One depth-first walk over a JSON-shaped payload, shared by the three readings the
 * holding-id rules need (#1263): the ids a tool answer surfaced, the holding a tool
 * input points at, and the name a read paired with an id.
 *
 * Its own module because all three had grown the same four-line recursion with the
 * same cycle guard, which is a promise to keep in one place: a payload no serializer
 * would take must not kill a chat turn over bookkeeping.
 */

/**
 * Visits every value, with the KEY it is reachable under — `null` only at the root.
 *
 * An array's items inherit their array's key, which is what makes `holdingIds: [a, b]`
 * read as two values of `holdingIds` rather than two anonymous strings. Objects are
 * visited before their contents, so a visitor can read a whole record and still see
 * its fields.
 */
export function walkDeep(
  value: unknown,
  visit: (key: string | null, value: unknown) => void,
): void {
  walk(null, value, visit, new WeakSet());
}

function walk(
  key: string | null,
  value: unknown,
  visit: (key: string | null, value: unknown) => void,
  seen: WeakSet<object>,
): void {
  visit(key, value);
  if (typeof value !== "object" || value === null || seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) walk(key, item, visit, seen);
    return;
  }
  for (const [nestedKey, nested] of Object.entries(value)) {
    walk(nestedKey, nested, visit, seen);
  }
}
