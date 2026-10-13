"use client";

/**
 * A link into the tabbed ficha: to a tab and the field in it where something is
 * fixed (#1828) — «Indicar símbolo» beside the price, «Ver operaciones» in the
 * warnings band — or to an action's panel (#1830), the empty Cobros tab's «Añadir un
 * cobro».
 *
 * It is a real `<a href>` to that view, so it works with JS off, from the keyboard,
 * in a new tab or from a copied link. With JS a plain click asks the ficha to
 * conmute in place instead (interaction-patterns §2, §8): a cancelable window event
 * the island claims — the tab shown and the field focused, or the panel opened with
 * focus back on THIS link when it closes. An event and not a context because the
 * band sits outside the island; one mechanism, so the two kinds of link cannot
 * drift apart (#1731 review). A ficha that does not offer what the link asks for
 * leaves the click alone, and the link simply navigates.
 */

import { isPlainAnchorClick } from "@web/view-state";
import type { ReactNode } from "react";
import { FICHA_OPEN_EVENT, type FichaOpenRequest } from "./ficha-view";

/** What the ask carries: the view it wants, and the link that asked (§8). */
export interface FichaOpenDetail {
  request: FichaOpenRequest;
  trigger: HTMLElement;
}

export function FichaLink({
  action,
  children,
  className,
  field,
  href,
  tab,
}: {
  /** The `?accion=` of the panel to open. */
  action?: string;
  children: ReactNode;
  className?: string;
  /** The `name` of the field to focus once the tab is on show. */
  field?: string;
  /** The same view as a URL, for every click the island does not take. */
  href: string;
  /** The `?pestaña=` to show. */
  tab?: string;
}) {
  return (
    <a
      className={className}
      data-ficha-field={field}
      data-ficha-tab={tab}
      href={href}
      onClick={(event) => {
        if (!isPlainAnchorClick(event)) return;
        const detail: FichaOpenDetail = {
          request: {
            ...(tab ? { tab } : {}),
            ...(action ? { action } : {}),
            ...(field ? { field } : {}),
          },
          trigger: event.currentTarget,
        };
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
