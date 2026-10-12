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
import { type FreshRows, freshRowKeys, type RowKeys } from "./fresh-row-keys";

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

/** The keys of `list` the last server render added — empty when none or outside a ficha. */
export function useFreshRows(list: string): ReadonlySet<string> {
  return useContext(FreshRowsContext)[list] ?? NONE;
}
