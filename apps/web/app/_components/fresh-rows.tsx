"use client";

/**
 * The rows the last server render added, for whichever list wants to point at them
 * (#1829): «la fila nueva sale destacada».
 *
 * The provider sits high enough to outlive the terminal — the ficha's island, which
 * stays mounted across the redirect that lands a registration — and compares each
 * render's row keys with the previous one's (`fresh-row-keys.ts`). A list mounted
 * only after the landing (the «Cobros» tab, opened by that same terminal) still
 * gets its fresh rows, because the keys travel with the provider, not with the list.
 *
 * Outside a provider nothing is fresh, so a list placed anywhere else is unchanged.
 */

import { createContext, type ReactNode, useContext, useState } from "react";
import {
  type FreshRows,
  freshRowKeys,
  type RowKeys,
  type RowList,
} from "./fresh-row-keys";

const NONE: ReadonlySet<string> = new Set();

const FreshRowsContext = createContext<FreshRows>({});

export function FreshRowsProvider({
  children,
  rows,
}: {
  children: ReactNode;
  /** Each list's row keys, as the server listed them on this render. */
  rows: RowKeys;
}) {
  // Adjusting state to a prop that changed (React's own recipe, no effect): the
  // first render compares nothing; every later server render compares with the one
  // before. A client-only re-render (a tab toggle) hands the same `rows` back, so
  // the mark stays until a render brings something else.
  const [seen, setSeen] = useState(rows);
  const [fresh, setFresh] = useState<FreshRows>({});
  if (rows !== seen) {
    setSeen(rows);
    setFresh(freshRowKeys(seen, rows));
  }

  return <FreshRowsContext.Provider value={fresh}>{children}</FreshRowsContext.Provider>;
}

/**
 * Fresh rows given outright instead of found between two renders: how a single
 * static render — a test — puts a list on the real `useFreshRows` path.
 */
export function FixedFreshRows({
  children,
  fresh,
}: {
  children: ReactNode;
  fresh: FreshRows;
}) {
  return <FreshRowsContext.Provider value={fresh}>{children}</FreshRowsContext.Provider>;
}

/** The keys of `list` the last server render added — empty when none or outside a ficha. */
export function useFreshRows(list: RowList): ReadonlySet<string> {
  return useContext(FreshRowsContext)[list] ?? NONE;
}

/**
 * A row of a server-rendered list, tinted (`data-fresh`) when the last render added
 * it — the piece a server component drops in where a client hook cannot go.
 */
export function FreshRow({
  children,
  className,
  list,
  rowKey,
}: {
  children: ReactNode;
  className: string;
  list: RowList;
  rowKey: string;
}) {
  const fresh = useFreshRows(list).has(rowKey);
  return (
    <div className={className} data-fresh={fresh ? "" : undefined}>
      {children}
    </div>
  );
}

/** {@link FreshRow} for a table: the `<tr>` itself carries the tint (#1848). */
export function FreshTableRow({
  children,
  list,
  rowKey,
}: {
  children: ReactNode;
  list: RowList;
  rowKey: string;
}) {
  const fresh = useFreshRows(list).has(rowKey);
  return <tr data-fresh={fresh ? "" : undefined}>{children}</tr>;
}

/** The same mark in words — the tint alone is not a reading (canon §8). */
export function FreshMark({
  list,
  rowKey,
  word,
}: {
  list: RowList;
  rowKey: string;
  /** «nueva» or «nuevo», agreeing with what the row is. */
  word: string;
}) {
  return useFreshRows(list).has(rowKey) ? (
    <small className="fichaFreshMark">{word}</small>
  ) : null;
}
