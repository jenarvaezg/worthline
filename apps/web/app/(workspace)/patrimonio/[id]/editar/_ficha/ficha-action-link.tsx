"use client";

/**
 * A link printed INSIDE a tab that opens one of the ficha's actions (#1830) — the
 * empty Cobros tab's «Añadir un cobro», whose form lives in the side panel.
 *
 * The tab is server-rendered (ADR 0036), so it cannot reach the island's state; the
 * island hands its opener down through context instead, and a plain click goes
 * through it exactly like the bar's buttons: `?accion=` pushed, no round-trip, and
 * focus back on THIS link when the panel closes (interaction-patterns §3, §8). The
 * `href` is the same view spelled as a URL (`fichaActionUrl`), so a modified click,
 * a copied link or a page with no JS still lands on the open panel.
 */

import { isPlainAnchorClick } from "@web/view-state";
import { createContext, type ReactNode, useContext } from "react";

/** Open `key`'s panel, remembering the control that asked so focus can go back. */
export type OpenFichaAction = (key: string, trigger: HTMLElement | null) => void;

/** The tabbed ficha's opener; null outside one, where the link is a plain link. */
export const FichaActionOpener = createContext<OpenFichaAction | null>(null);

export function FichaActionLink({
  action,
  children,
  href,
}: {
  /** The action's `?accion=` key. */
  action: string;
  children: ReactNode;
  /** The ficha with that panel open, for every click the island does not take. */
  href: string;
}) {
  const open = useContext(FichaActionOpener);
  return (
    <a
      href={href}
      onClick={(event) => {
        if (open === null || !isPlainAnchorClick(event)) return;
        event.preventDefault();
        open(action, event.currentTarget);
      }}
    >
      {children}
    </a>
  );
}
