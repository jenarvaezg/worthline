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
 * «Cerrar» or Esc, and focus goes back to the control that opened it (§8). A link
 * anywhere on the page (`FichaLink`) can ask for a tab, a field or a panel too.
 *
 * Adding never needs a search (#1829). Once the action bar scrolls away, a strip
 * keeps the habitual action at hand (`ficha-strip.tsx`). And a registration from
 * the panel lands where its result shows (`ficha-landing.ts`): the notice beside
 * the tabs, the row the render added marked (`FreshRowsProvider`), and «Añadir otra»
 * re-opening the same form with its date and currency (`FormSeedProvider`).
 */

import { type FormSeed, FormSeedProvider } from "@web/_components/form-seed";
import type { RowKeys } from "@web/_components/fresh-row-keys";
import { FreshRowsProvider } from "@web/_components/fresh-rows";
import { OWN_LANDING_ATTRIBUTE } from "@web/form-submit-scroll";
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
import { useFichaLanding } from "./ficha-landing";
import type { FichaOpenDetail } from "./ficha-link";
import { FichaMoreMenu } from "./ficha-more-menu";
import { FichaStrip } from "./ficha-strip";
import {
  claimFichaOpen,
  FICHA_OPEN_EVENT,
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
  /**
   * What the holding is to its owner, for the regions' names: «Estado del activo»,
   * or «Estado de la deuda» on a debt's ficha (#1848).
   */
  subject?: "activo" | "deuda";
  instrument: string | null;
  /** The value — the one dominant figure of the page. */
  value: string;
  figures: readonly FichaFigure[];
  actions: readonly FichaAction[];
  tabs: readonly FichaTab[];
  errorTargets: Readonly<Record<string, FichaTarget>>;
  /** The success the URL reports (`?ok=`), in words — null when there is none. */
  notice: string | null;
  /** The keys of the rows each tab lists, to point at the ones a terminal added. */
  rows: RowKeys;
}

const PANEL_TITLE_ID = "ficha-panel-title";
const NOTICE_ID = "ficha-notice";

/** Its forms' terminals land where the ficha says (#1829), not where the page was. */
const OWN_LANDING = { [OWN_LANDING_ATTRIBUTE]: "" };

export function HoldingFicha({
  actions,
  basePath,
  boardHref,
  errorTargets,
  figures,
  instrument,
  name,
  notice,
  rows,
  subject = "activo",
  tabs,
  value,
}: HoldingFichaProps) {
  const ofHolding = subject === "deuda" ? "de la deuda" : "del activo";
  const spec = useMemo<FichaViewSpec>(
    () => ({
      actions: actions.map((action) => action.key),
      errorTargets,
      tabs: tabs.map((tab) => tab.key),
    }),
    [actions, errorTargets, tabs],
  );
  const params = useSearchParams();
  const view = readFichaView(params, spec);
  const current = actions.find((action) => action.key === view.action) ?? null;
  const activeTab = tabs.find((tab) => tab.key === view.tab) ?? tabs[0];
  const openKey = current?.key ?? null;

  const rootRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const actionsRef = useRef<HTMLDivElement>(null);
  // The control that opened the panel, so closing it can hand focus back (§8).
  const opener = useRef<HTMLElement | null>(null);
  // What «Añadir otra» re-opens its form with, for as long as that panel is open.
  const [seedFor, setSeedFor] = useState<{ action: string; seed: FormSeed } | null>(null);

  const landing = useFichaLanding({
    ok: params.get("ok"),
    openAction: openKey,
    panelRef,
    rootRef,
    searchKey: params.toString(),
  });

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

  // Closing by hand abandons whatever the panel had sent and not yet landed: a
  // later success elsewhere on the ficha is not that submit's.
  const { forget } = landing;
  const closePanel = useCallback(() => {
    forget();
    show({ action: null });
  }, [forget, show]);

  // Focus follows the panel: into it when it opens — a deep link included — and back
  // to its opener when it closes, whether by «Cerrar», Esc, Back or a terminal that
  // landed on the bare ficha. With no opener to return to (the panel came from a
  // link), the action's own control in the bar is where it would have been opened.
  const shownKey = useRef<string | null>(null);
  useEffect(() => {
    const previous = shownKey.current;
    shownKey.current = openKey;
    // A seed is for the opening «Añadir otra» made; once that panel goes, so does it.
    if (previous !== null && openKey !== previous) {
      setSeedFor((seeded) => (seeded?.action === previous ? null : seeded));
    }
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
        closePanel();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [openKey, closePanel]);

  // A link into the ficha (`FichaLink`) — «Indicar símbolo» beside the price, a
  // warning's «Ver operaciones» in the band (#1828), Cobros' «Añadir un cobro»
  // (#1830) — asks for a tab and a field, or an action: the tab switches in place
  // and the cursor lands on the field, or the panel opens and gives focus back to
  // the link when it closes (§8). Declared after the panel's focus effect so, when
  // the ask also closes a panel, the field keeps the focus rather than the opener.
  const [focusAsk, setFocusAsk] = useState<{ field: string; tab: string } | null>(null);
  useEffect(() => {
    function onOpen(event: Event) {
      const { request, trigger } = (event as CustomEvent<FichaOpenDetail>).detail;
      const change = claimFichaOpen(request, spec);
      if (change === null) return;
      event.preventDefault();
      if (change.action) opener.current = trigger;
      setFocusAsk(
        request.field && change.tab ? { field: request.field, tab: change.tab } : null,
      );
      show(change);
    }
    window.addEventListener(FICHA_OPEN_EVENT, onOpen);
    return () => window.removeEventListener(FICHA_OPEN_EVENT, onOpen);
  }, [show, spec]);
  const activeTabKey = activeTab?.key;
  useEffect(() => {
    // The asked tab is not on show yet: the render that shows it runs this again.
    if (focusAsk === null || focusAsk.tab !== activeTabKey) return;
    setFocusAsk(null);
    rootRef.current
      ?.querySelector<HTMLElement>(`.fichaTabBody [name="${focusAsk.field}"]`)
      ?.focus();
  }, [activeTabKey, focusAsk]);

  const panelTop = usePanelTop(openKey !== null);

  const shown = actions.filter((action) => action.tier !== "more");
  const more = actions.filter((action) => action.tier === "more");
  const again =
    actions.find((action) => action.key === landing.againKey && action.again) ?? null;
  const landed = landing.landed;

  const ficha = (
    <div className="ficha" onSubmitCapture={landing.onSubmitCapture} ref={rootRef}>
      <section aria-label={`Estado ${ofHolding}`} className="heroPanel fichaHero">
        <div className="fichaHeroTop">
          <div className="fichaIdentity">
            <Link className="fichaBack" href={boardHref}>
              ← Patrimonio
            </Link>
            <h2>{name}</h2>
            {instrument ? <span className="fichaInstrument">{instrument}</span> : null}
            {/* A debt's figure carries the Línea del debe, as its pane does on the
                board (canon §6): the «−» alone is not what marks a pasivo. */}
            <p className={subject === "deuda" ? "fichaValue debitCol" : "fichaValue"}>
              {value}
            </p>
          </div>

          <div
            aria-label={`Acciones ${ofHolding}`}
            className="fichaActions"
            ref={actionsRef}
            role="group"
          >
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
                <span
                  className={`fichaFigure${figure.kind === "text" ? " fichaFigureText" : ""} ${figure.tone ?? ""}`}
                >
                  {figure.value}
                </span>
                {figure.detail ? (
                  <div className="fichaFigureDetail">{figure.detail}</div>
                ) : null}
              </dd>
            </div>
          ))}
        </dl>
      </section>

      {/* Beside the tabs, where the result landed. The live region is always in the
          document — empty and out of sight until a terminal brings words — because
          one inserted together with its text is not reliably announced (§8). Its
          `role="status"` holds the words only, so the offer is a control and not
          part of the announcement; the offer names it as its description. */}
      <div
        className={notice ? "successBand fichaNotice" : "srOnly"}
        ref={landing.noticeRef}
        tabIndex={notice ? -1 : undefined}
      >
        <p id={NOTICE_ID} role="status">
          {notice}
        </p>
        {notice && again && landed ? (
          <button
            aria-describedby={NOTICE_ID}
            className="btn btnSecondary fichaNoticeAgain"
            onClick={(event) => {
              setSeedFor({ action: again.key, seed: landed.submission.seed });
              openAction(again.key, event.currentTarget);
            }}
            ref={landing.againRef}
            type="button"
          >
            {again.again}
          </button>
        ) : null}
      </div>

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

      <div className="fichaTabBody">{activeTab?.content}</div>

      {current ? (
        <section
          aria-labelledby={PANEL_TITLE_ID}
          aria-modal="false"
          className="fichaPanel"
          {...OWN_LANDING}
          ref={panelRef}
          role="dialog"
          style={{ "--ficha-panel-top": `${panelTop}px` } as CSSProperties}
          tabIndex={-1}
        >
          <header className="fichaPanelHead">
            <h3 id={PANEL_TITLE_ID}>{current.label}</h3>
            <button className="btn btnSecondary" onClick={closePanel} type="button">
              Cerrar
            </button>
          </header>
          <div className="fichaPanelBody" key={current.key}>
            <FormSeedProvider
              seed={seedFor?.action === current.key ? seedFor.seed : null}
            >
              {current.content}
            </FormSeedProvider>
          </div>
        </section>
      ) : null}

      <FichaStrip
        actions={actions}
        barRef={actionsRef}
        columnRef={rootRef}
        hidden={openKey !== null}
        name={name}
        onOpen={openAction}
        openKey={openKey}
        value={value}
      />
    </div>
  );

  // Above the whole ficha, so the rows a terminal added are known to whichever
  // tab shows them — the «Cobros» grid mounts with the very landing (#1829).
  return <FreshRowsProvider rows={rows}>{ficha}</FreshRowsProvider>;
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
