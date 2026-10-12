/**
 * Which rows a render brought that the previous one did not (#1829).
 *
 * After registering something, the ficha lands on the tab where it shows and points
 * at the row it added. The row is found by the data, not by the form: the one key
 * the server lists now and did not list on the previous render — the operation a
 * buy wrote, the half of a traspaso this ledger keeps, the cobro just added, the
 * recurring cobro just declared. It is ONE row: a render that adds several to a
 * list is a load (a statement's eleven movements), not «la fila nueva», and marking
 * them all would unfold the compact ledger past its ten latest — so it singles none
 * out. A delete, a price refresh or a «Lo básico» save adds none, so the mark
 * clears on the next render.
 *
 * Pure (interaction-patterns §7): the client provider keeps the previous render's
 * keys and asks this; the rule is the test.
 */

/**
 * The lists a ficha points a fresh row in, by name (#1731 review): the ledger, the
 * Cobros grid (one-offs and each schedule's occurrences) and the declared recurring
 * cobros. A schedule adds several occurrences to the grid — or none, if it starts
 * later — so it is pointed at in its own list.
 */
export type RowList = "operaciones" | "cobros" | "recurrentes";

/** Each list the ficha shows, by name, as the keys of its rows. */
export type RowKeys = Readonly<Partial<Record<RowList, readonly string[]>>>;

/** Each list's fresh keys — empty when the render added nothing to it. */
export type FreshRows = Readonly<Partial<Record<RowList, ReadonlySet<string>>>>;

/**
 * The key of `after` that `before` did not hold, list by list, when it is exactly one.
 * A list `before` did not carry has nothing to compare against, so none of its rows
 * is fresh — the first render of a list would otherwise mark all of it.
 */
export function freshRowKeys(before: RowKeys, after: RowKeys): FreshRows {
  return Object.fromEntries(
    Object.entries(after).map(([list, keys]) => {
      const previous = before[list as RowList];
      if (previous === undefined) return [list, new Set<string>()];
      const known = new Set(previous);
      const added = keys.filter((key) => !known.has(key));
      return [list, new Set(added.length === 1 ? added : [])];
    }),
  );
}
