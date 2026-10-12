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
 *
 * Adding never needs a search (#1829). Once the action bar scrolls away, a strip
 * keeps the habitual action at hand (`ficha-strip.tsx`). And a submit from the
 * panel keeps its terminal untouched — success redirects, a refusal comes back in
 * place (#1311, interaction-patterns §4.1); nothing here pushes a URL while it is in
 * flight — but the island remembers what left (`ficha-again.ts`), so when the URL
 * lands on that submit's success it brings the result into view: the notice beside
 * the tabs, the row the render added marked (`FreshRowsProvider`), and «Añadir otra»
 * re-opening the same form with its date and currency (`FormSeedProvider`).
 */

import {
  type FormSeed,
  FormSeedProvider,
  SEED_CHOICE_ATTRIBUTE,
} from "@web/_components/form-seed";
import type { RowKeys } from "@web/_components/fresh-row-keys";
import { FreshRowsProvider } from "@web/_components/fresh-rows";
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
  type FormEvent,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { FichaActionOpener } from "./ficha-action-link";
import {
  againFor,
  type LandedSubmission,
  landedOk,
  type PanelSubmission,
  panelSubmission,
  stillLanded,
} from "./ficha-again";
import { FichaMoreMenu } from "./ficha-more-menu";
import { FichaStrip } from "./ficha-strip";
import {
  claimFichaOpen,
  FICHA_OPEN_EVENT,
  type FichaOpenRequest,
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
  /** The success the URL reports (`?ok=`), in words — null when there is none. */
  notice: string | null;
  /** The keys of the rows each tab lists, to point at the ones a terminal added. */
  rows: RowKeys;
}

const PANEL_TITLE_ID = "ficha-panel-title";
const NOTICE_ID = "ficha-notice";

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
  const params = useSearchParams();
  const searchKey = params.toString();
  const view = readFichaView(params, spec);
  const current = actions.find((action) => action.key === view.action) ?? null;
  const activeTab = tabs.find((tab) => tab.key === view.tab) ?? tabs[0];

  const rootRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const actionsRef = useRef<HTMLDivElement>(null);
  const noticeRef = useRef<HTMLDivElement>(null);
  const againRef = useRef<HTMLButtonElement>(null);
  // The control that opened the panel, so closing it can hand focus back (§8).
  const opener = useRef<HTMLElement | null>(null);
  // The panel submit still waiting for its terminal, and the one that landed.
  const pending = useRef<PanelSubmission | null>(null);
  const [landed, setLanded] = useState<LandedSubmission | null>(null);
  // What «Añadir otra» re-opens its form with, for as long as that panel is open.
  const [seedFor, setSeedFor] = useState<{ action: string; seed: FormSeed } | null>(null);

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
  const closePanel = useCallback(() => {
    pending.current = null;
    show({ action: null });
  }, [show]);

  const openKey = current?.key ?? null;

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

  // What leaves the panel is remembered — which action, where its terminal returns,
  // its date and currency — and nothing else is touched: the form's own handler
  // still runs its action and keeps its terminal. A submit from anywhere else on
  // the ficha (a delete in the ledger, «Lo básico») forgets it.
  function onSubmitCapture(event: FormEvent<HTMLDivElement>) {
    const form = event.target;
    if (!(form instanceof HTMLFormElement)) return;
    if (current === null || !panelRef.current?.contains(form)) {
      pending.current = null;
      // The person moved on: this submit's own success is not the panel's.
      setLanded(null);
      return;
    }
    const choice = form
      .closest(`[${SEED_CHOICE_ATTRIBUTE}]`)
      ?.getAttribute(SEED_CHOICE_ATTRIBUTE);
    pending.current = panelSubmission(current.key, new FormData(form), choice);
  }

  // The URL moved: if it is the success of what the panel sent, that submit landed;
  // otherwise whatever had landed lasts only while the URL still reports it.
  useEffect(() => {
    const submitted = pending.current;
    const ok = submitted
      ? landedOk(submitted, { pathname: window.location.pathname, search: searchKey })
      : null;
    if (submitted !== null && ok !== null) {
      pending.current = null;
      setLanded({ ok, submission: submitted });
      return;
    }
    setLanded((previous) =>
      stillLanded(previous, new URLSearchParams(searchKey).get("ok")),
    );
  }, [searchKey]);

  // It landed: bring the result into view — the row the render added, then the
  // notice — and put focus where the next step is, «Añadir otra». When both fit,
  // the usual case, both are on screen. When they do not (a long Cobros tab), the
  // notice wins: focus goes to its offer, and focus never lands on something the
  // view left (§8) — the row stays marked for whoever scrolls to it. The page's
  // scroll keeper leaves this terminal alone (`data-own-landing`).
  useEffect(() => {
    if (landed === null) return;
    const band = noticeRef.current;
    rootRef.current?.querySelector("[data-fresh]")?.scrollIntoView({ block: "nearest" });
    band?.scrollIntoView({ block: "nearest" });
    (againRef.current ?? band)?.focus({ preventScroll: true });
  }, [landed]);

  // A link to where something is fixed — «Indicar símbolo» beside the price, a
  // warning's «Ver operaciones» in the band (#1828) — asks for a tab and a field:
  // the tab switches in place and the cursor lands on the field (§8). Declared
  // after the panel's focus effect so, when the ask also closes a panel, the field
  // keeps the focus rather than the panel's opener.
  const [focusAsk, setFocusAsk] = useState<Required<FichaOpenRequest> | null>(null);
  useEffect(() => {
    function onOpen(event: Event) {
      const request = (event as CustomEvent<FichaOpenRequest>).detail;
      const change = claimFichaOpen(request, spec);
      if (change === null) return;
      event.preventDefault();
      setFocusAsk(request.field ? { field: request.field, tab: change.tab } : null);
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
  const barOutOfView = useScrolledPast(actionsRef);
  const stripPlace = useStripPlace(rootRef, barOutOfView);

  const shown = actions.filter((action) => action.tier !== "more");
  const more = actions.filter((action) => action.tier === "more");

  // «Añadir otra»: offered while the URL still reports the success that landed, by
  // an action that offers it, and with no panel open (`againFor`).
  const againKey = againFor(landed, {
    ok: params.get("ok"),
    panelOpen: openKey !== null,
  });
  const again = actions.find((action) => action.key === againKey && action.again) ?? null;

  const ficha = (
    <div className="ficha" onSubmitCapture={onSubmitCapture} ref={rootRef}>
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

          <div
            aria-label="Acciones del activo"
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
                <span className={`fichaFigure ${figure.tone ?? ""}`}>{figure.value}</span>
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
        ref={noticeRef}
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
            ref={againRef}
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
          // Its forms' terminals land where the ficha says, not where the page
          // behind the panel happened to be scrolled (#1829).
          data-own-landing=""
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

      {barOutOfView ? (
        <FichaStrip
          actions={actions}
          hidden={openKey !== null}
          name={name}
          onOpen={openAction}
          openKey={openKey}
          place={stripPlace}
          value={value}
        />
      ) : null}
    </div>
  );

  // Above the whole ficha, so the rows a terminal added are known to whichever
  // tab shows them — the «Cobros» grid mounts with the very landing (#1829).
  return <FreshRowsProvider rows={rows}>{ficha}</FreshRowsProvider>;
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
  rootRef: RefObject<HTMLElement | null>,
  isShown: boolean,
): CSSProperties | undefined {
  const [place, setPlace] = useState<CSSProperties | undefined>(undefined);
  // Before paint, so the strip never shows a frame in the fallback place.
  useLayoutEffect(() => {
    if (!isShown) return;
    function measure() {
      const column = rootRef.current?.getBoundingClientRect();
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
  }, [isShown, rootRef]);
  return place;
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
