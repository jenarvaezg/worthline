"use client";

/**
 * PROTOTIPO #1737 — desechable. Tres variantes de la ficha de un activo de
 * inversión sobre la ruta real, conmutables con `?variante=A|B|C`:
 *
 * - A «En la página»: una columna ancha; el formulario se abre bajo la barra.
 * - B «Panel lateral»: cabecera con la barra a la derecha; el formulario se abre
 *   en una hoja lateral (a pantalla completa en móvil) y la lista sigue visible.
 * - C «Columna fija»: en escritorio, cabecera y acciones forman una columna lateral
 *   que acompaña al desplazarse; las pestañas ocupan la columna principal.
 *
 * Todas comparten lo acordado en #1737: cabecera de estado, barra de acciones,
 * formulario dentro de la ficha (`?accion=`) y pestañas (`?pestaña=`).
 *
 * NADA SE GUARDA: la raíz corta todo envío en fase de captura (antes de que React
 * despache la acción del formulario) y simula el aterrizaje de Q14.
 */

import Link from "next/link";
import { type FormEvent, type ReactNode, useEffect, useRef, useState } from "react";
import styles from "./ficha-prototype.module.css";
import {
  ACTIONS,
  type ActionKey,
  type ActionSpec,
  type PrototypeExtras,
  type PrototypeFigures,
  TABS,
  type TabKey,
  type VariantKey,
} from "./prototype-model";
import { PrototypeSwitcher } from "./prototype-switcher";
import { VariantB2 } from "./variant-b2";

export interface FichaPrototypeProps {
  extras: PrototypeExtras;
  initialVariant: VariantKey;
  initialAction: ActionKey | null;
  initialTab: TabKey;
  figures: PrototypeFigures;
  refresh: ReactNode;
  warnings: ReactNode;
  forms: Partial<Record<ActionKey, ReactNode>>;
  tabs: Record<TabKey, ReactNode>;
  operationCount: number;
  boardHref: string;
}

interface Notice {
  kind: "success" | "blocked";
  text: string;
  again: ActionKey | null;
}

const AGAIN_LABEL: Partial<Record<ActionKey, string>> = {
  cobro: "Añadir otro",
  correccion: "Corregir otro día",
  entrada: "Añadir otra",
  operacion: "Añadir otra",
  traspaso: "Registrar otro",
};

export default function FichaPrototype(props: FichaPrototypeProps) {
  const [variant, setVariant] = useState<VariantKey>(props.initialVariant);
  const [action, setAction] = useState<ActionKey | null>(props.initialAction);
  const [tab, setTab] = useState<TabKey>(props.initialTab);
  const [opsExpanded, setOpsExpanded] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [cobroKind, setCobroKind] = useState<"suelto" | "recurrente">("suelto");
  const lastTrigger = useRef<HTMLElement | null>(null);

  const available = ACTIONS.filter((spec) => props.forms[spec.key] !== undefined);
  const current = available.find((spec) => spec.key === action) ?? null;

  // Al cerrarse el formulario, el foco vuelve al botón que lo abrió.
  useEffect(() => {
    if (current || !lastTrigger.current) return;
    lastTrigger.current.focus({ preventScroll: true });
    lastTrigger.current = null;
  }, [current]);

  function onBlocked(text: string) {
    setNotice({ again: null, kind: "blocked", text });
  }

  function onFixSymbol() {
    setAction(null);
    setTab("datos");
    window.setTimeout(() => {
      const input = document.querySelector<HTMLInputElement>(
        'input[name="providerSymbol"]',
      );
      input?.scrollIntoView({ block: "center" });
      input?.focus({ preventScroll: true });
    }, 60);
  }

  // La URL es la fuente de verdad (interaction-patterns §3): se espeja sin recargar.
  useEffect(() => {
    const url = new URL(window.location.href);
    url.searchParams.set("variante", variant);
    url.searchParams.delete("abrir");
    if (current) url.searchParams.set("accion", current.key);
    else url.searchParams.delete("accion");
    if (tab === "operaciones") url.searchParams.delete("pestaña");
    else url.searchParams.set("pestaña", tab);
    window.history.replaceState(window.history.state, "", url);
  }, [variant, current, tab]);

  useEffect(() => {
    if (!current) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setAction(null);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [current]);

  function openAction(key: ActionKey) {
    setNotice(null);
    if (document.activeElement instanceof HTMLElement) {
      lastTrigger.current = document.activeElement;
    }
    setAction((open) => (open === key ? null : key));
  }

  function onSubmitCapture(event: FormEvent<HTMLDivElement>) {
    event.preventDefault();
    event.stopPropagation();
    const slot = (event.target as HTMLElement).closest<HTMLElement>(
      "[data-proto-action]",
    );
    const spec = ACTIONS.find((candidate) => candidate.key === slot?.dataset.protoAction);
    if (spec) {
      setAction(null);
      setTab(spec.landsOn);
      setNotice({
        again: AGAIN_LABEL[spec.key] ? spec.key : null,
        kind: "success",
        text: spec.done,
      });
    } else {
      setNotice({
        again: null,
        kind: "blocked",
        text: "Prototipo: este envío no se guarda.",
      });
    }
  }

  const sheet = current ? (
    <section
      aria-label={current.label}
      className={styles.sheet}
      data-proto-action={current.key}
    >
      <header className={styles.sheetHead}>
        <h3>{current.label}</h3>
        <button
          className="btnSecondary btnSmall"
          onClick={() => setAction(null)}
          type="button"
        >
          Cerrar
        </button>
      </header>
      {variant === "B2" && current.key === "cobro" ? (
        <div
          aria-label="Tipo de cobro"
          className={`segmented ${styles.cobroKind}`}
          role="group"
        >
          <button
            aria-pressed={cobroKind === "suelto"}
            onClick={() => setCobroKind("suelto")}
            type="button"
          >
            Un cobro suelto
          </button>
          <button
            aria-pressed={cobroKind === "recurrente"}
            onClick={() => setCobroKind("recurrente")}
            type="button"
          >
            Uno que se repite
          </button>
        </div>
      ) : null}
      <div
        className={`${styles.sheetBody} ${slotClass(current.key) ?? ""}`}
        data-kind={variant === "B2" ? cobroKind : undefined}
      >
        {props.forms[current.key]}
      </div>
    </section>
  ) : null;

  const noticeBand = notice ? (
    <p
      className={notice.kind === "success" ? "successBand" : "warningBand"}
      role="status"
    >
      {notice.text}{" "}
      {notice.kind === "success" ? (
        <small>(Prototipo: no se ha guardado nada.)</small>
      ) : null}{" "}
      {notice.again ? (
        <button
          className="btnSecondary btnSmall"
          onClick={() => notice.again && openAction(notice.again)}
          type="button"
        >
          {AGAIN_LABEL[notice.again]}
        </button>
      ) : null}
    </p>
  ) : null;

  const tabBody = (
    <div
      className={
        tab === "operaciones"
          ? styles.opsTab
          : tab === "cobros"
            ? styles.cobrosTab
            : undefined
      }
      data-expanded={opsExpanded}
    >
      {props.tabs[tab]}
      {tab === "operaciones" && props.operationCount > 10 ? (
        <button
          className={`btnSecondary btnSmall ${styles.moreOps}`}
          onClick={() => setOpsExpanded((open) => !open)}
          type="button"
        >
          {opsExpanded
            ? "Ver solo las 10 últimas"
            : `Ver las ${props.operationCount} operaciones`}
        </button>
      ) : null}
    </div>
  );

  const layout: LayoutProps = {
    available,
    boardHref: props.boardHref,
    current,
    figures: props.figures,
    noticeBand,
    onOpen: openAction,
    onTab: setTab,
    refresh: props.refresh,
    sheet,
    tab,
    tabBody,
    variant,
    warnings: props.warnings,
  };

  return (
    <div className={styles.root} onSubmitCapture={onSubmitCapture}>
      {variant === "A" ? <VariantA {...layout} /> : null}
      {variant === "B" ? <VariantB {...layout} /> : null}
      {variant === "B2" ? (
        <VariantB2
          available={available}
          boardHref={props.boardHref}
          current={current}
          extras={props.extras}
          figures={props.figures}
          noticeBand={noticeBand}
          onBlocked={onBlocked}
          onFixSymbol={onFixSymbol}
          onOpen={openAction}
          onTab={setTab}
          operationCount={props.operationCount}
          refresh={props.refresh}
          sheet={sheet}
          tab={tab}
          tabs={props.tabs}
        />
      ) : null}
      {variant === "C" ? <VariantC {...layout} /> : null}
      <PrototypeSwitcher current={variant} onChange={setVariant} />
    </div>
  );
}

function slotClass(key: ActionKey): string | undefined {
  if (key === "operacion") return styles.opForm;
  if (key === "cobro") return styles.cobroForm;
  return undefined;
}

interface LayoutProps {
  available: readonly ActionSpec[];
  boardHref: string;
  current: ActionSpec | null;
  figures: PrototypeFigures;
  noticeBand: ReactNode;
  onOpen: (key: ActionKey) => void;
  onTab: (key: TabKey) => void;
  refresh: ReactNode;
  sheet: ReactNode;
  tab: TabKey;
  tabBody: ReactNode;
  variant: VariantKey;
  warnings: ReactNode;
}

// ── Variante A — en la página ──────────────────────────────────────────────

function VariantA(p: LayoutProps) {
  return (
    <div className={styles.a}>
      <TitleRow boardHref={p.boardHref} figures={p.figures} />
      {p.warnings}
      <section aria-label="Estado del activo" className={`heroPanel ${styles.aHero}`}>
        <Figures figures={p.figures} layout="strip" refresh={p.refresh} />
      </section>
      <ActionBar
        available={p.available}
        current={p.current}
        onOpen={p.onOpen}
        variant="bar"
      />
      {p.sheet}
      {p.noticeBand}
      <TabNav current={p.tab} onTab={p.onTab} tabStyle="rule" variant={p.variant} />
      {p.tabBody}
    </div>
  );
}

// ── Variante B — panel lateral ─────────────────────────────────────────────

function VariantB(p: LayoutProps) {
  const drawerRef = useRef<HTMLElement>(null);
  const openKey = p.current?.key;
  useEffect(() => {
    if (openKey) drawerRef.current?.focus();
  }, [openKey]);

  return (
    <div className={`${styles.b} ${p.current ? styles.bWithDrawer : ""}`}>
      <section aria-label="Estado del activo" className={`heroPanel ${styles.bHero}`}>
        <div className={styles.bTop}>
          <div className={styles.bIdentity}>
            <Link className={styles.back} href={p.boardHref}>
              ← Patrimonio
            </Link>
            <h2>{p.figures.name}</h2>
            {p.figures.instrument ? (
              <span className={styles.instrument}>{p.figures.instrument}</span>
            ) : null}
            <p className={`${styles.num} ${styles.bValue}`}>{p.figures.value ?? "—"}</p>
          </div>
          <ActionBar
            available={p.available}
            current={p.current}
            onOpen={p.onOpen}
            variant="toolbar"
          />
        </div>
        <Figures figures={p.figures} layout="line" refresh={p.refresh} />
      </section>
      {p.warnings}
      {p.noticeBand}
      <TabNav current={p.tab} onTab={p.onTab} tabStyle="boxed" variant={p.variant} />
      {p.tabBody}
      {p.current ? (
        <aside
          aria-label={p.current.label}
          className={styles.drawer}
          ref={drawerRef}
          tabIndex={-1}
        >
          {p.sheet}
        </aside>
      ) : null}
    </div>
  );
}

// ── Variante C — columna fija ──────────────────────────────────────────────

function VariantC(p: LayoutProps) {
  return (
    <div className={styles.c}>
      <aside aria-label="Estado y acciones del activo" className={styles.cAside}>
        <div>
          <Link className={styles.back} href={p.boardHref}>
            ← Patrimonio
          </Link>
          <h2 className={styles.cName}>{p.figures.name}</h2>
          {p.figures.instrument ? (
            <span className={styles.instrument}>{p.figures.instrument}</span>
          ) : null}
        </div>
        <Figures figures={p.figures} layout="stack" refresh={p.refresh} />
        <ActionList available={p.available} current={p.current} onOpen={p.onOpen} />
      </aside>
      <div className={styles.cMain}>
        {p.warnings}
        {p.sheet}
        {p.noticeBand}
        <TabNav current={p.tab} onTab={p.onTab} tabStyle="rule" variant={p.variant} />
        {p.tabBody}
      </div>
    </div>
  );
}

// ── Piezas ─────────────────────────────────────────────────────────────────

function TitleRow({
  boardHref,
  figures,
}: {
  boardHref: string;
  figures: PrototypeFigures;
}) {
  return (
    <div className={styles.titleRow}>
      <div className={styles.titleMain}>
        <h2>{figures.name}</h2>
        {figures.instrument ? (
          <span className={styles.instrument}>{figures.instrument}</span>
        ) : null}
      </div>
      <Link className={styles.back} href={boardHref}>
        ← Patrimonio
      </Link>
    </div>
  );
}

function Figures({
  figures,
  layout,
  refresh,
}: {
  figures: PrototypeFigures;
  layout: "strip" | "line" | "stack";
  refresh: ReactNode;
}) {
  const { gain, irr } = figures;
  return (
    <dl className={styles[layout]}>
      {layout === "line" ? null : (
        <div className={styles.figValue}>
          <dt>Valor</dt>
          <dd className={styles.num}>{figures.value ?? "—"}</dd>
        </div>
      )}
      <div>
        <dt>Participaciones × precio</dt>
        <dd>
          <span className={styles.num}>
            {figures.units ?? "—"} × {figures.price ?? "sin precio"}
          </span>{" "}
          <small className={`priceStatus ${figures.priceFreshness ?? "unknown"}`}>
            {figures.priceFreshnessLabel}
          </small>
          {figures.priceCaption ? (
            <small className={styles.caption}>{figures.priceCaption}</small>
          ) : null}
          {refresh ? <div className={styles.refresh}>{refresh}</div> : null}
        </dd>
      </div>
      <div>
        <dt>Ganancia total</dt>
        <dd className={`${styles.num} ${gain?.sign ?? ""}`}>
          {gain ? `${gain.amount} · ${gain.pct}` : "—"}
        </dd>
      </div>
      <div>
        <dt>TIR</dt>
        <dd className={`${styles.num} ${irr?.sign ?? ""}`}>{irr?.pct ?? "—"}</dd>
      </div>
    </dl>
  );
}

function ActionBar({
  available,
  current,
  onOpen,
  variant,
}: {
  available: readonly ActionSpec[];
  current: ActionSpec | null;
  onOpen: (key: ActionKey) => void;
  variant: "bar" | "toolbar";
}) {
  const moreRef = useRef<HTMLDetailsElement>(null);
  const shown = available.filter((spec) => spec.tier !== "more");
  const more = available.filter((spec) => spec.tier === "more");
  const moreActive = more.some((spec) => spec.key === current?.key);

  return (
    <div
      aria-label="Acciones del activo"
      className={variant === "bar" ? styles.bar : styles.toolbar}
      role="toolbar"
    >
      {shown.map((spec) => (
        <button
          aria-pressed={current?.key === spec.key}
          className={
            spec.tier === "primary"
              ? `btn ${styles.primaryBtn}`
              : `btn btnSecondary ${styles.secondaryBtn}`
          }
          key={spec.key}
          onClick={() => onOpen(spec.key)}
          type="button"
        >
          {spec.label}
        </button>
      ))}
      {more.length > 0 ? (
        <details className={styles.more} ref={moreRef} suppressHydrationWarning>
          <summary
            className={`btn btnSecondary ${styles.moreSummary} ${moreActive ? styles.moreActive : ""}`}
          >
            Más ▾
          </summary>
          <ul className={styles.moreMenu}>
            {more.map((spec) => (
              <li key={spec.key}>
                <button
                  className={styles.menuItem}
                  onClick={() => {
                    if (moreRef.current) moreRef.current.open = false;
                    onOpen(spec.key);
                  }}
                  type="button"
                >
                  {spec.label}
                </button>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}

function ActionList({
  available,
  current,
  onOpen,
}: {
  available: readonly ActionSpec[];
  current: ActionSpec | null;
  onOpen: (key: ActionKey) => void;
}) {
  const primary = available.filter((spec) => spec.tier === "primary");
  const rest = available.filter((spec) => spec.tier !== "primary");
  const groups = ["Movimientos", "Cobros", "Precios"] as const;

  return (
    <nav aria-label="Acciones del activo" className={styles.actionList}>
      {primary.map((spec) => (
        <button
          aria-pressed={current?.key === spec.key}
          className={`btn ${styles.primaryBtn} ${styles.fullWidth}`}
          key={spec.key}
          onClick={() => onOpen(spec.key)}
          type="button"
        >
          {spec.label}
        </button>
      ))}
      <div className={styles.actionGroups}>
        {groups.map((group) => {
          const items = rest.filter((spec) => spec.group === group);
          if (items.length === 0) return null;
          return (
            <div className={styles.actionGroup} key={group}>
              <h4>{group}</h4>
              {items.map((spec) => (
                <button
                  aria-pressed={current?.key === spec.key}
                  className={styles.listBtn}
                  key={spec.key}
                  onClick={() => onOpen(spec.key)}
                  type="button"
                >
                  {spec.label}
                </button>
              ))}
            </div>
          );
        })}
      </div>
    </nav>
  );
}

function TabNav({
  current,
  onTab,
  tabStyle,
  variant,
}: {
  current: TabKey;
  onTab: (key: TabKey) => void;
  tabStyle: "rule" | "boxed";
  variant: VariantKey;
}) {
  return (
    <nav
      aria-label="Secciones de la ficha"
      className={tabStyle === "boxed" ? "framingTabs" : styles.ruleTabs}
    >
      {TABS.map((spec) => {
        const isActive = spec.key === current;
        return (
          <a
            aria-current={isActive ? "true" : undefined}
            className={
              tabStyle === "rule"
                ? `navTab ${isActive ? "active" : ""}`
                : isActive
                  ? "active"
                  : undefined
            }
            href={`?variante=${variant}&pestaña=${spec.key}`}
            key={spec.key}
            onClick={(event) => {
              event.preventDefault();
              onTab(spec.key);
            }}
          >
            {spec.label}
          </a>
        );
      })}
    </nav>
  );
}
