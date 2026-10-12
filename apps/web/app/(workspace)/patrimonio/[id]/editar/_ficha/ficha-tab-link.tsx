"use client";

/**
 * A link to the place on the ficha where something is fixed (#1828): a tab, and the
 * field in it to put the cursor on — «Indicar símbolo» beside the price, «Ver
 * operaciones» in the warnings band.
 *
 * It is a real `<a href>` to that tab, so it works with JS off and from the
 * keyboard. With JS it asks the tabbed ficha to switch in place instead: the ficha
 * conmuta the tab without a round-trip and focuses the field (interaction-patterns
 * §2, §8). The ask is a cancelable window event rather than a context because the
 * band sits outside the island, above the header; a ficha that offers the tab
 * claims it, and an unclaimed click simply follows the link.
 */

import { isPlainAnchorClick } from "@web/view-state";
import type { ReactNode } from "react";
import { FICHA_OPEN_EVENT, type FichaOpenRequest } from "./ficha-view";

export function FichaTabLink({
  children,
  className,
  field,
  href,
  tab,
}: {
  children: ReactNode;
  className?: string;
  /** The `name` of the field to focus once the tab is on show. */
  field?: string;
  /** The tab's own URL, for JS off and for a ficha that does not claim the click. */
  href: string;
  tab: string;
}) {
  return (
    <a
      className={className}
      data-ficha-field={field}
      data-ficha-tab={tab}
      href={href}
      onClick={(event) => {
        if (!isPlainAnchorClick(event)) return;
        const detail: FichaOpenRequest = field ? { field, tab } : { tab };
        const unclaimed = window.dispatchEvent(
          new CustomEvent(FICHA_OPEN_EVENT, { cancelable: true, detail }),
        );
        if (!unclaimed) event.preventDefault();
      }}
    >
      {children}
    </a>
  );
}
