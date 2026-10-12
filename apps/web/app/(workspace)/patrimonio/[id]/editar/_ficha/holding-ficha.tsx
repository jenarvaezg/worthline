"use client";

/**
 * The tabbed ficha (#1826, B2 of #1737): a state header with the action bar beside
 * it, the tabs under it, and one action at a time in a side panel. The common piece
 * every family that moves to tabs renders — the family says what it carries
 * (`FichaLayout`), this says how it behaves.
 *
 * RSC first (ADR 0036): the server rendered every figure, every tab and every form;
 * this island only chooses which tab and which panel are on show. That choice lives
 * in the URL (`?pestaña=`, `?accion=`, interaction-patterns §3) and is READ from it
 * through `useSearchParams`, never held beside it: a toggle `pushState`s, Back pops,
 * and a terminal that redirects to the bare ficha (`?ok=saved`) closes the panel by
 * itself, because the URL it lands on names no action. The rules are the pure
 * `ficha-view.ts`; what is left here is wiring.
 *
 * The panel overlays the page without moving it, starting under the top bar while
 * the bar is on screen; on a phone it takes the whole screen. It closes with
 * «Cerrar» or Esc, and focus goes back to the control that opened it (§8).
 */

import type {
  FichaAction,
  FichaFigure,
  FichaTab,
} from "@web/patrimonio/[id]/editar/_families/family-contract";
import { pushMirroredUrl } from "@web/url-view-state";
import { isPlainAnchorClick } from "@web/view-state";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import {
  type CSSProperties,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { FichaActionOpener } from "./ficha-action-link";
import { FichaMoreMenu } from "./ficha-more-menu";
import {
  type FichaTarget,
  type FichaView,
  type FichaViewSpec,
  fichaTabUrl,
  readFichaView,
  writeFichaView,
} from "./ficha-view";

export interface HoldingFichaProps {
  /** The ficha's own URL: every tab's `href` is built on it. */
  basePath: string;
  /** «← Patrimonio»: the holding's row on the board. */
  boardHref: string;
  name: string;
  instrument: string | null;
  /** The value — the one dominant figure of the page. */
  value: string;
  figures: readonly FichaFigure[];
  actions: readonly FichaAction[];
  tabs: readonly FichaTab[];
  errorTargets: Readonly<Record<string, FichaTarget>>;
}

const PANEL_TITLE_ID = "ficha-panel-title";

export function HoldingFicha({
  actions,
  basePath,
  boardHref,
  errorTargets,
  figures,
  instrument,
  name,
  tabs,
  value,
}: HoldingFichaProps) {
  const spec = useMemo<FichaViewSpec>(
    () => ({
      actions: actions.map((action) => action.key),
      errorTargets,
      tabs: tabs.map((tab) => tab.key),
    }),
    [actions, errorTargets, tabs],
  );
  const view = readFichaView(useSearchParams(), spec);
  const current = actions.find((action) => action.key === view.action) ?? null;
  const activeTab = tabs.find((tab) => tab.key === view.tab) ?? tabs[0];

  const rootRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  // The control that opened the panel, so closing it can hand focus back (§8).
  const opener = useRef<HTMLElement | null>(null);

  const show = useCallback(
    (change: Partial<FichaView>) => {
      const { hash, pathname, search } = window.location;
      pushMirroredUrl(`${pathname}${writeFichaView(search, spec, change)}${hash}`);
    },
    [spec],
  );

  function openAction(key: string, trigger: HTMLElement | null) {
    opener.current = trigger;
    show({ action: key });
  }

  const openKey = current?.key ?? null;

  // Focus follows the panel: into it when it opens — a deep link included — and back
  // to its opener when it closes, whether by «Cerrar», Esc, Back or a terminal that
  // landed on the bare ficha. With no opener to return to (the panel came from a
  // link), the action's own control in the bar is where it would have been opened.
  const shownKey = useRef<string | null>(null);
  useEffect(() => {
    const previous = shownKey.current;
    shownKey.current = openKey;
    if (openKey !== null && openKey !== previous) {
      panelRef.current?.focus();
      return;
    }
    if (openKey === null && previous !== null) {
      const back = opener.current?.isConnected
        ? opener.current
        : rootRef.current?.querySelector<HTMLElement>(
            `[data-ficha-action="${previous}"], [data-ficha-more]`,
          );
      opener.current = null;
      back?.focus({ preventScroll: true });
    }
  }, [openKey]);

  // Esc closes the panel — unless something inside it took the key first (the
  // «Más» menu closes itself before the panel does).
  useEffect(() => {
    if (openKey === null) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && !event.defaultPrevented) {
        show({ action: null });
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [openKey, show]);

  const panelTop = usePanelTop(openKey !== null);

  const shown = actions.filter((action) => action.tier !== "more");
  const more = actions.filter((action) => action.tier === "more");

  return (
    <div className="ficha" ref={rootRef}>
      <section aria-label="Estado del activo" className="heroPanel fichaHero">
        <div className="fichaHeroTop">
          <div className="fichaIdentity">
            <Link className="fichaBack" href={boardHref}>
              ← Patrimonio
            </Link>
            <h2>{name}</h2>
            {instrument ? <span className="fichaInstrument">{instrument}</span> : null}
            <p className="fichaValue">{value}</p>
          </div>

          <div aria-label="Acciones del activo" className="fichaActions" role="group">
            {shown.map((action) => (
              <button
                aria-expanded={action.key === openKey}
                className={action.tier === "primary" ? "btn" : "btn btnSecondary"}
                data-ficha-action={action.key}
                key={action.key}
                onClick={(event) => openAction(action.key, event.currentTarget)}
                type="button"
              >
                {action.label}
              </button>
            ))}
            {more.length > 0 ? (
              <FichaMoreMenu
                active={more.some((action) => action.key === openKey)}
                items={more}
                onOpen={openAction}
              />
            ) : null}
          </div>
        </div>

        <dl className="fichaFigures">
          {figures.map((figure) => (
            <div key={figure.key}>
              <dt>{figure.label}</dt>
              <dd>
                <span className={`fichaFigure ${figure.tone ?? ""}`}>{figure.value}</span>
                {figure.detail ? (
                  <div className="fichaFigureDetail">{figure.detail}</div>
                ) : null}
              </dd>
            </div>
          ))}
        </dl>
      </section>

      <nav aria-label="Secciones de la ficha" className="fichaTabs">
        {tabs.map((tab) => {
          const isActive = tab.key === activeTab?.key;
          return (
            <a
              aria-current={isActive ? "true" : undefined}
              className={isActive ? "navTab active" : "navTab"}
              href={fichaTabUrl(basePath, spec.tabs, tab.key)}
              key={tab.key}
              onClick={(event) => {
                if (!isPlainAnchorClick(event)) return;
                event.preventDefault();
                show({ tab: tab.key });
              }}
            >
              {tab.shortLabel ? (
                <>
                  <span className="fichaTabWide">{tab.label}</span>
                  <span className="fichaTabNarrow">{tab.shortLabel}</span>
                </>
              ) : (
                tab.label
              )}
              {tab.count !== undefined ? (
                <span className="fichaTabCount">{tab.count}</span>
              ) : null}
            </a>
          );
        })}
      </nav>
      {/* A client toggle is not a document navigation, so it is not announced (§8). */}
      <p aria-live="polite" className="srOnly">{`Sección: ${activeTab?.label ?? ""}`}</p>

      <div className="fichaTabBody">
        {/* A link inside a tab opens an action the way the bar does (#1830). */}
        <FichaActionOpener.Provider value={openAction}>
          {activeTab?.content}
        </FichaActionOpener.Provider>
      </div>

      {current ? (
        <section
          aria-labelledby={PANEL_TITLE_ID}
          aria-modal="false"
          className="fichaPanel"
          ref={panelRef}
          role="dialog"
          style={{ "--ficha-panel-top": `${panelTop}px` } as CSSProperties}
          tabIndex={-1}
        >
          <header className="fichaPanelHead">
            <h3 id={PANEL_TITLE_ID}>{current.label}</h3>
            <button
              className="btn btnSecondary"
              onClick={() => show({ action: null })}
              type="button"
            >
              Cerrar
            </button>
          </header>
          <div className="fichaPanelBody" key={current.key}>
            {current.content}
          </div>
        </section>
      ) : null}
    </div>
  );
}

/**
 * Where the panel starts: under the top bar while the bar is on screen, at the top
 * once it has scrolled away — the bar is not sticky, so this follows the scroll.
 */
function usePanelTop(isOpen: boolean): number {
  const [top, setTop] = useState(0);
  useEffect(() => {
    if (!isOpen) return;
    function place() {
      const bar = document.querySelector("header.topbar");
      setTop(Math.max(0, Math.round(bar?.getBoundingClientRect().bottom ?? 0)));
    }
    place();
    window.addEventListener("scroll", place, { passive: true });
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place);
      window.removeEventListener("resize", place);
    };
  }, [isOpen]);
  return top;
}
