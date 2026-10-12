"use client";

import type { FichaAction } from "@web/patrimonio/[id]/editar/_families/family-contract";
import {
  type CSSProperties,
  type RefObject,
  useEffect,
  useLayoutEffect,
  useState,
} from "react";
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
 * whatever the width; which parts show is the stylesheet's call. It shows only
 * once the bar is out of view, which it watches itself (`useScrolledPast`). While
 * a panel is open the strip is hidden rather than unmounted, so the button that
 * opened the panel is still there to take focus back when it closes (§8).
 */
export function FichaStrip({
  actions,
  barRef,
  columnRef,
  hidden,
  name,
  onOpen,
  openKey,
  value,
}: {
  actions: readonly FichaAction[];
  /** The action bar it stands in for: the strip shows once this scrolls away. */
  barRef: RefObject<HTMLElement | null>;
  /** The ficha's column, whose left edge and width it takes on a desktop. */
  columnRef: RefObject<HTMLElement | null>;
  /** A panel is open: the strip steps aside. */
  hidden: boolean;
  name: string;
  onOpen: (key: string, trigger: HTMLElement | null) => void;
  openKey: string | null;
  value: string;
}) {
  const barOutOfView = useScrolledPast(barRef);
  const place = useStripPlace(columnRef, barOutOfView);
  if (!barOutOfView) return null;

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

/**
 * The workspace's scope rail (`.tabsBar`, #47) sticks to the top of the screen
 * while scrolling. The strip sits under it instead of covering it, so a scope stays
 * one click away too; this is the height it leaves, 0 where there is none.
 */
function stickyRailHeight(): number {
  return Math.round(
    document.querySelector(".tabsBar")?.getBoundingClientRect().height ?? 0,
  );
}

/**
 * Whether `ref`'s element has scrolled out of sight past the top — under the
 * sticky scope rail counts, since it is hidden there too — and not merely below
 * the fold, which is where nothing has been scrolled yet.
 */
function useScrolledPast(ref: RefObject<HTMLElement | null>): boolean {
  const [past, setPast] = useState(false);
  useEffect(() => {
    const element = ref.current;
    if (!element || typeof IntersectionObserver === "undefined") return;
    const rail = stickyRailHeight();
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry) {
          setPast(!entry.isIntersecting && entry.boundingClientRect.top < rail);
        }
      },
      { rootMargin: `-${rail}px 0px 0px 0px` },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return past;
}

/**
 * Where the strip goes on a desktop: over the ficha's own column — it is that
 * column's header, condensed — and under the sticky scope rail. Measured, because
 * neither is fixed: the column is the page's, the rail the shell's. (On a phone the
 * stylesheet pins it to the bottom and ignores these.)
 */
function useStripPlace(
  columnRef: RefObject<HTMLElement | null>,
  isShown: boolean,
): CSSProperties | undefined {
  const [place, setPlace] = useState<CSSProperties | undefined>(undefined);
  // Before paint, so the strip never shows a frame in the fallback place.
  useLayoutEffect(() => {
    if (!isShown) return;
    function measure() {
      const column = columnRef.current?.getBoundingClientRect();
      if (!column) return;
      setPlace({
        "--ficha-strip-left": `${Math.round(column.left)}px`,
        "--ficha-strip-top": `${stickyRailHeight()}px`,
        "--ficha-strip-width": `${Math.round(column.width)}px`,
      } as CSSProperties);
    }
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [isShown, columnRef]);
  return place;
}
