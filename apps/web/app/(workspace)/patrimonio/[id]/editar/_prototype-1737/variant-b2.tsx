"use client";

/**
 * PROTOTIPO #1737 — desechable. Variante B2: la B («panel lateral») con las
 * mejoras 1-11 de la revisión del 12/10:
 *
 * 1. Al salir la cabecera de la pantalla, una franja fija (arriba en escritorio,
 *    un botón abajo en móvil) mantiene «Registrar operación» a mano.
 * 2. «Añadir cobro» pregunta antes: suelto o recurrente (lo pinta la isla madre).
 * 3. El panel se superpone sin recolocar la página y empieza bajo la barra de
 *    navegación; al cerrarse, el foco vuelve al botón que lo abrió.
 * 4. Sin cobros, «Añadir cobro» se va a «Más».
 * 5. El precio dice de dónde sale y de cuándo.
 * 6. El aviso de símbolo va junto al precio; el resto sigue arriba.
 * 7. «Rentabilidad anual» en lugar de «TIR» a secas.
 * 8. Pestañas de regla con recuento; el negro, solo para la acción principal.
 * 9-10. Libro de operaciones compacto con importe y «···»; en móvil, dos renglones.
 * 11. En móvil, las cifras en rejilla.
 */

import Link from "next/link";
import {
  type CSSProperties,
  type ReactNode,
  type RefObject,
  useEffect,
  useRef,
  useState,
} from "react";
import styles from "./ficha-prototype.module.css";
import {
  type ActionKey,
  type ActionSpec,
  type LedgerRow,
  type PrototypeExtras,
  type PrototypeFigures,
  TABS,
  type TabKey,
} from "./prototype-model";

export interface VariantB2Props {
  available: readonly ActionSpec[];
  boardHref: string;
  current: ActionSpec | null;
  extras: PrototypeExtras;
  figures: PrototypeFigures;
  noticeBand: ReactNode;
  onBlocked: (text: string) => void;
  onFixSymbol: () => void;
  onOpen: (key: ActionKey) => void;
  onTab: (key: TabKey) => void;
  operationCount: number;
  refresh: ReactNode;
  sheet: ReactNode;
  tab: TabKey;
  tabs: Record<TabKey, ReactNode>;
}

export function VariantB2(p: VariantB2Props) {
  const { extras, figures } = p;
  // 4: un activo que nunca ha pagado nada no necesita el botón a la vista.
  const actions = p.available.map((spec) =>
    spec.key === "cobro" && extras.cobroCount === 0
      ? { ...spec, tier: "more" as const }
      : spec,
  );

  // 1: ¿se ven aún los botones? Basta con que se vayan ellos, aunque asome el resto.
  const heroRef = useRef<HTMLDivElement>(null);
  const [heroOut, setHeroOut] = useState(false);
  useEffect(() => {
    const hero = heroRef.current;
    if (!hero) return;
    const observer = new IntersectionObserver(([entry]) => {
      setHeroOut(entry ? !entry.isIntersecting : false);
    });
    observer.observe(hero);
    return () => observer.disconnect();
  }, []);

  // 3: el panel empieza donde acaba la barra de navegación, mientras se vea.
  const drawerRef = useRef<HTMLElement>(null);
  const [drawerTop, setDrawerTop] = useState(0);
  const openKey = p.current?.key;
  useEffect(() => {
    if (!openKey) return;
    drawerRef.current?.focus();
    function place() {
      const topbar = document.querySelector("header.topbar");
      const bottom = topbar ? topbar.getBoundingClientRect().bottom : 0;
      setDrawerTop(Math.max(0, Math.round(bottom)));
    }
    place();
    window.addEventListener("scroll", place, { passive: true });
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place);
      window.removeEventListener("resize", place);
    };
  }, [openKey]);

  const [ledgerExpanded, setLedgerExpanded] = useState(false);

  return (
    <div className={styles.b2}>
      {extras.otherWarnings.length > 0 ? (
        <div aria-label="Avisos" className="warningBand" role="alert">
          {extras.otherWarnings.map((warning) => (
            <div className="warningItem" key={warning.code}>
              <span>⚠ {warning.message}</span>
              {warning.overrideable ? (
                <button
                  className="btnSmall btnWarning"
                  onClick={() => p.onBlocked("Prototipo: «Es intencional» no se guarda.")}
                  type="button"
                >
                  Es intencional
                </button>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}

      <section aria-label="Estado del activo" className={`heroPanel ${styles.bHero}`}>
        <div className={styles.bTop}>
          <div className={styles.bIdentity}>
            <Link className={styles.back} href={p.boardHref}>
              ← Patrimonio
            </Link>
            <h2>{figures.name}</h2>
            {figures.instrument ? (
              <span className={styles.instrument}>{figures.instrument}</span>
            ) : null}
            <p className={`${styles.num} ${styles.bValue}`}>{figures.value ?? "—"}</p>
          </div>
          <Toolbar
            actions={actions}
            current={p.current}
            onOpen={p.onOpen}
            rootRef={heroRef}
          />
        </div>

        <dl className={styles.b2Figures}>
          <div className={styles.b2Units}>
            <dt>Participaciones</dt>
            <dd>
              <span className={styles.num}>{figures.units ?? "—"}</span>
              {extras.priceLine.value ? (
                <>
                  {" a "}
                  <span className={styles.num}>{extras.priceLine.value}</span>
                </>
              ) : null}
              <small className={styles.caption}>{extras.priceLine.origin}</small>
              {extras.missingSymbol ? (
                <p className={styles.inlineWarn}>
                  ⚠ Sin cotización automática.{" "}
                  <button
                    className={styles.linkBtn}
                    onClick={p.onFixSymbol}
                    type="button"
                  >
                    Indicar símbolo
                  </button>
                  {" · "}
                  <button
                    className={styles.linkBtn}
                    onClick={() =>
                      p.onBlocked("Prototipo: «Cotiza a mano» no se guarda.")
                    }
                    type="button"
                  >
                    Cotiza a mano
                  </button>
                </p>
              ) : null}
              {p.refresh ? <div className={styles.refresh}>{p.refresh}</div> : null}
            </dd>
          </div>
          <div>
            <dt>Ganancia total</dt>
            <dd className={`${styles.num} ${figures.gain?.sign ?? ""}`}>
              {figures.gain ? `${figures.gain.amount} · ${figures.gain.pct}` : "—"}
            </dd>
          </div>
          <div>
            <dt>
              Rentabilidad anual{" "}
              <abbr
                className={styles.abbr}
                title="TIR: tiene en cuenta cuándo pusiste cada euro"
              >
                TIR
              </abbr>
            </dt>
            <dd className={`${styles.num} ${figures.irr?.sign ?? ""}`}>
              {figures.irr?.pct ?? "—"}
            </dd>
          </div>
        </dl>
      </section>

      {p.noticeBand}

      <nav aria-label="Secciones de la ficha" className={styles.ruleTabs}>
        {TABS.map((spec) => {
          const isActive = spec.key === p.tab;
          const count =
            spec.key === "operaciones"
              ? p.operationCount
              : spec.key === "cobros"
                ? extras.cobroCount
                : null;
          return (
            <a
              aria-current={isActive ? "true" : undefined}
              className={`navTab ${isActive ? "active" : ""}`}
              href={`?variante=B2&pestaña=${spec.key}`}
              key={spec.key}
              onClick={(event) => {
                event.preventDefault();
                p.onTab(spec.key);
              }}
            >
              {spec.key === "datos" ? (
                <>
                  Datos<span className={styles.wideOnly}> del activo</span>
                </>
              ) : (
                spec.label
              )}
              {count !== null ? <span className={styles.tabCount}>{count}</span> : null}
            </a>
          );
        })}
      </nav>

      {p.tab === "operaciones" ? (
        <Ledger
          expanded={ledgerExpanded}
          onBlocked={p.onBlocked}
          onToggle={() => setLedgerExpanded((open) => !open)}
          rows={extras.ledger}
        />
      ) : (
        <div className={p.tab === "cobros" ? styles.cobrosTab : undefined}>
          {p.tabs[p.tab]}
        </div>
      )}

      {p.current ? (
        <aside
          aria-label={p.current.label}
          className={`${styles.drawer} ${styles.b2Drawer}`}
          ref={drawerRef}
          style={{ "--drawer-top": `${drawerTop}px` } as CSSProperties}
          tabIndex={-1}
        >
          {p.sheet}
        </aside>
      ) : null}

      {heroOut && !p.current ? (
        <StickyBar actions={actions} figures={figures} onOpen={p.onOpen} />
      ) : null}
    </div>
  );
}

function Toolbar({
  actions,
  current,
  onOpen,
  rootRef,
}: {
  actions: readonly ActionSpec[];
  current: ActionSpec | null;
  onOpen: (key: ActionKey) => void;
  rootRef: RefObject<HTMLDivElement | null>;
}) {
  const shown = actions.filter((spec) => spec.tier !== "more");
  const more = actions.filter((spec) => spec.tier === "more");
  return (
    <div
      aria-label="Acciones del activo"
      className={styles.toolbar}
      ref={rootRef}
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
      <MoreMenu current={current} items={more} onOpen={onOpen} />
    </div>
  );
}

function MoreMenu({
  current,
  items,
  onOpen,
}: {
  current: ActionSpec | null;
  items: readonly ActionSpec[];
  onOpen: (key: ActionKey) => void;
}) {
  const ref = useRef<HTMLDetailsElement>(null);
  if (items.length === 0) return null;
  const active = items.some((spec) => spec.key === current?.key);
  return (
    <details className={styles.more} ref={ref} suppressHydrationWarning>
      <summary
        className={`btn btnSecondary ${styles.moreSummary} ${active ? styles.moreActive : ""}`}
      >
        Más ▾
      </summary>
      <ul className={styles.moreMenu}>
        {items.map((spec) => (
          <li key={spec.key}>
            <button
              className={styles.menuItem}
              onClick={() => {
                if (ref.current) ref.current.open = false;
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
  );
}

function StickyBar({
  actions,
  figures,
  onOpen,
}: {
  actions: readonly ActionSpec[];
  figures: PrototypeFigures;
  onOpen: (key: ActionKey) => void;
}) {
  const primary = actions.find((spec) => spec.tier === "primary");
  const rest = actions.filter((spec) => spec.tier !== "primary");
  return (
    <>
      <div className={styles.stickyTop}>
        <div className={styles.stickyInner}>
          <strong>{figures.name}</strong>
          <span className={styles.num}>{figures.value ?? "—"}</span>
          <span className={styles.stickySpacer} />
          {primary ? (
            <button className="btn" onClick={() => onOpen(primary.key)} type="button">
              {primary.label}
            </button>
          ) : null}
          <MoreMenu current={null} items={rest} onOpen={onOpen} />
        </div>
      </div>
      {primary ? (
        <button
          className={`btn ${styles.stickyCta}`}
          onClick={() => onOpen(primary.key)}
          type="button"
        >
          {primary.label}
        </button>
      ) : null}
    </>
  );
}

function Ledger({
  expanded,
  onBlocked,
  onToggle,
  rows,
}: {
  expanded: boolean;
  onBlocked: (text: string) => void;
  onToggle: () => void;
  rows: readonly LedgerRow[];
}) {
  const shown = expanded ? rows : rows.slice(0, 10);
  if (rows.length === 0) {
    return <p className="emptyLine">Todavía no hay operaciones.</p>;
  }
  return (
    <div>
      <ol aria-label="Operaciones" className={styles.ledger}>
        <li aria-hidden="true" className={`${styles.ledgerRow} ${styles.ledgerHead}`}>
          <span className={styles.dOnly}>Fecha</span>
          <span className={styles.dOnly}>Tipo</span>
          <span className={`${styles.dOnly} ${styles.right}`}>Particip.</span>
          <span className={`${styles.dOnly} ${styles.right}`}>Precio</span>
          <span className={`${styles.dOnly} ${styles.right}`}>Comisión</span>
          <span className={styles.right}>Importe</span>
          <span />
        </li>
        {shown.map((row) => (
          <li className={styles.ledgerRow} key={row.id}>
            <span className={`${styles.dOnly} ${styles.num}`}>{row.date}</span>
            <span className={styles.dOnly}>
              {row.kind}
              {row.note ? <small className={styles.ledgerNote}>{row.note}</small> : null}
            </span>
            <span className={`${styles.dOnly} ${styles.num} ${styles.right}`}>
              {row.units}
            </span>
            <span className={`${styles.dOnly} ${styles.num} ${styles.right}`}>
              {row.price}
            </span>
            <span className={`${styles.dOnly} ${styles.num} ${styles.right}`}>
              {row.fees ?? "—"}
            </span>
            <span className={`${styles.mOnly} ${styles.mWhen}`}>
              {row.date} · {row.kind}
              {row.note ? <small className={styles.ledgerNote}>{row.note}</small> : null}
            </span>
            <span className={`${styles.mOnly} ${styles.mCalc} ${styles.num}`}>
              {row.units} × {row.price}
              {row.fees ? ` · comisión ${row.fees}` : ""}
            </span>
            <span className={`${styles.num} ${styles.right} ${styles.ledgerAmount}`}>
              {row.amount}
            </span>
            <details className={styles.rowMenu} suppressHydrationWarning>
              <summary aria-label={`Acciones de la operación del ${row.date}`}>
                ···
              </summary>
              <div className={styles.rowMenuList}>
                <button
                  className={`${styles.menuItem} ${styles.danger}`}
                  onClick={() => onBlocked("Prototipo: eliminar no se guarda.")}
                  type="button"
                >
                  Eliminar
                </button>
              </div>
            </details>
          </li>
        ))}
      </ol>
      {rows.length > 10 ? (
        <button
          className={`btnSecondary btnSmall ${styles.moreOps}`}
          onClick={onToggle}
          type="button"
        >
          {expanded ? "Ver solo las 10 últimas" : `Ver las ${rows.length} operaciones`}
        </button>
      ) : null}
    </div>
  );
}
