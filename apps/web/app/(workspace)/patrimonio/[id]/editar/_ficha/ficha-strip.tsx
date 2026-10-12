"use client";

import type { FichaAction } from "@web/patrimonio/[id]/editar/_families/family-contract";
import type { CSSProperties } from "react";
import { FichaMoreMenu } from "./ficha-more-menu";

/**
 * The action bar, kept at hand once it has scrolled away (#1829): registering an
 * operation costs one click from anywhere on the ficha, however far down the
 * ledger the person has gone — the dolor that leads #1731, «añadir cualquier cosa
 * es un coñazo».
 *
 * On a desktop it is a strip pinned to the top, over the ficha's own column and
 * under the sticky scope rail: the name, the value, the habitual action and «Más»
 * with every other one. On a phone the same strip is pinned to the
 * bottom and keeps only the habitual action, left of the assistant's launcher so it
 * never covers it — one element, so there is one «Registrar operación» to find,
 * whatever the width; which parts show is the stylesheet's call. The island decides
 * only WHEN — the bar out of view, and no panel open. While a panel is open the
 * strip is hidden rather than unmounted, so the button that opened the panel is
 * still there to take focus back when it closes (§8).
 */
export function FichaStrip({
  actions,
  hidden,
  name,
  onOpen,
  openKey,
  place,
  value,
}: {
  actions: readonly FichaAction[];
  /** A panel is open: the strip steps aside. */
  hidden: boolean;
  name: string;
  onOpen: (key: string, trigger: HTMLElement | null) => void;
  openKey: string | null;
  /** Where it sits on a desktop, measured by the island (`--ficha-strip-*`). */
  place?: CSSProperties | undefined;
  value: string;
}) {
  const primary = actions.find((action) => action.tier === "primary") ?? null;
  const rest = actions.filter((action) => action !== primary);

  return (
    <div
      aria-label="Acciones a mano"
      className="fichaStrip"
      hidden={hidden}
      role="group"
      style={place}
    >
      <div className="fichaStripInner">
        <strong className="fichaStripName">{name}</strong>
        <span className="fichaStripValue">{value}</span>
        {primary ? (
          <button
            className="btn fichaStripPrimary"
            onClick={(event) => onOpen(primary.key, event.currentTarget)}
            type="button"
          >
            {primary.label}
          </button>
        ) : null}
        {rest.length > 0 ? (
          <FichaMoreMenu
            active={rest.some((action) => action.key === openKey)}
            items={rest}
            onOpen={onOpen}
          />
        ) : null}
      </div>
    </div>
  );
}
