"use client";

/**
 * PROTOTIPO #1527 — desechable. La isla que monta las tres variantes del selector
 * sobre un formulario que NO envía: el botón enseña lo que habría posteado, que es
 * justo lo que hay que comprobar (un chip oculto por el buscador sigue enviándose).
 */

import { LIQUIDITY_TIER_LABELS, type LiquidityTier } from "@worthline/domain";
import { type KeyboardEvent, useCallback, useEffect, useMemo, useState } from "react";
import {
  type CatalogKey,
  type CatalogRow,
  discriminatorFor,
  editScenarioIds,
  FOLDED_RUNGS,
  groupByRung,
  rowMatches,
  twinNames,
  VARIANTS,
  type VariantKey,
} from "./prototype-model";
import styles from "./selector-prototype.module.css";
import { VariantD } from "./variant-d";

type Scenario = "crear" | "editar";

interface VariantProps {
  rows: CatalogRow[];
  pinned: ReadonlySet<string>;
  selected: ReadonlySet<string>;
  toggle: (id: string) => void;
  twins: ReadonlySet<string>;
}

/** Enter en el buscador nunca envía el formulario. */
function guardEnter(event: KeyboardEvent<HTMLInputElement>, onEnter?: () => void) {
  if (event.key === "Enter") {
    event.preventDefault();
    onEnter?.();
  }
}

function Chip({
  row,
  selected,
  toggle,
  twins,
  hidden,
}: {
  row: CatalogRow;
  selected: boolean;
  toggle: (id: string) => void;
  twins: ReadonlySet<string>;
  hidden?: boolean;
}) {
  const code = discriminatorFor(row, twins);
  return (
    <label
      className={styles.chip}
      data-checked={selected || undefined}
      style={hidden ? { display: "none" } : undefined}
    >
      <input
        checked={selected}
        name="assetIds"
        onChange={() => toggle(row.id)}
        type="checkbox"
        value={row.id}
      />
      <span aria-hidden="true" className={styles.chipMark} />
      <span>{row.name}</span>
      {code ? <span className={styles.chipCode}>{code}</span> : null}
      <span className={styles.chipValue}>{row.valueLabel}</span>
    </label>
  );
}

// ── A · Chips agrupados ────────────────────────────────────────────────────

function VariantA({ rows, pinned, selected, toggle, twins }: VariantProps) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<ReadonlySet<LiquidityTier>>(new Set());
  const pinnedRows = rows.filter((row) => pinned.has(row.id));
  const groups = groupByRung(rows.filter((row) => !pinned.has(row.id)));
  const searching = query.trim() !== "";
  const totalMatches = groups.reduce(
    (sum, group) => sum + group.rows.filter((row) => rowMatches(row, query)).length,
    0,
  );

  return (
    <div className={styles.stack}>
      <input
        className={styles.search}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => guardEnter(event)}
        placeholder="Buscar por nombre o ISIN…"
        type="search"
        value={query}
      />
      {pinnedRows.length > 0 ? (
        <div className={styles.group}>
          <span className={styles.groupLabel}>Marcados · {pinnedRows.length}</span>
          <div className={styles.chips}>
            {pinnedRows.map((row) => (
              <Chip
                key={row.id}
                row={row}
                selected={selected.has(row.id)}
                toggle={toggle}
                twins={twins}
              />
            ))}
          </div>
        </div>
      ) : null}
      {groups.map((group) => {
        const matches = group.rows.filter((row) => rowMatches(row, query)).length;
        const folded = FOLDED_RUNGS.has(group.rung);
        const isOpen = searching ? matches > 0 : !folded || open.has(group.rung);
        return (
          <div
            className={styles.group}
            key={group.rung}
            style={searching && matches === 0 ? { display: "none" } : undefined}
          >
            {folded && !searching ? (
              <button
                aria-expanded={isOpen}
                className={styles.groupToggle}
                onClick={() =>
                  setOpen((prev) => {
                    const next = new Set(prev);
                    if (next.has(group.rung)) next.delete(group.rung);
                    else next.add(group.rung);
                    return next;
                  })
                }
                type="button"
              >
                {isOpen ? "▾" : "▸"} {LIQUIDITY_TIER_LABELS[group.rung]} ·{" "}
                {group.rows.length}
              </button>
            ) : (
              <span className={styles.groupLabel}>
                {LIQUIDITY_TIER_LABELS[group.rung]} ·{" "}
                {searching ? `${matches} de ${group.rows.length}` : group.rows.length}
              </span>
            )}
            <div
              className={styles.chips}
              style={isOpen ? undefined : { display: "none" }}
            >
              {group.rows.map((row) => (
                <Chip
                  hidden={!rowMatches(row, query)}
                  key={row.id}
                  row={row}
                  selected={selected.has(row.id)}
                  toggle={toggle}
                  twins={twins}
                />
              ))}
            </div>
          </div>
        );
      })}
      {searching && totalMatches === 0 ? (
        <p className={styles.empty}>Ningún activo coincide con «{query.trim()}».</p>
      ) : null}
    </div>
  );
}

// ── B · Libro con casillas ─────────────────────────────────────────────────

const LEDGER_PREVIEW = 6;

function LedgerRow({
  row,
  selected,
  toggle,
  twins,
  hidden,
}: {
  row: CatalogRow;
  selected: boolean;
  toggle: (id: string) => void;
  twins: ReadonlySet<string>;
  hidden?: boolean;
}) {
  const code = discriminatorFor(row, twins);
  return (
    <label
      className={styles.ledgerRow}
      data-checked={selected || undefined}
      style={hidden ? { display: "none" } : undefined}
    >
      <input
        checked={selected}
        name="assetIds"
        onChange={() => toggle(row.id)}
        type="checkbox"
        value={row.id}
      />
      <span className={styles.ledgerName}>
        {row.name}
        {code ? <span className={styles.ledgerCode}>{code}</span> : null}
      </span>
      <span className={styles.ledgerValue}>{row.valueLabel}</span>
    </label>
  );
}

function VariantB({ rows, pinned, selected, toggle, twins }: VariantProps) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<ReadonlySet<LiquidityTier>>(new Set());
  const [expanded, setExpanded] = useState<ReadonlySet<LiquidityTier>>(new Set());
  const pinnedRows = rows.filter((row) => pinned.has(row.id));
  const groups = groupByRung(rows.filter((row) => !pinned.has(row.id)));
  const searching = query.trim() !== "";
  const flip = (setter: typeof setOpen, rung: LiquidityTier) =>
    setter((prev) => {
      const next = new Set(prev);
      if (next.has(rung)) next.delete(rung);
      else next.add(rung);
      return next;
    });

  return (
    <div className={styles.stack}>
      <input
        className={styles.search}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => guardEnter(event)}
        placeholder="Buscar por nombre o ISIN…"
        type="search"
        value={query}
      />
      <div className={styles.ledger}>
        {pinnedRows.length > 0 ? (
          <>
            <div className={styles.ledgerHead}>
              <span>Marcados</span>
              <span>{pinnedRows.length}</span>
            </div>
            {pinnedRows.map((row) => (
              <LedgerRow
                key={row.id}
                row={row}
                selected={selected.has(row.id)}
                toggle={toggle}
                twins={twins}
              />
            ))}
          </>
        ) : null}
        {groups.map((group) => {
          const matching = group.rows.filter((row) => rowMatches(row, query));
          const folded = FOLDED_RUNGS.has(group.rung);
          const isOpen = searching
            ? matching.length > 0
            : !folded || open.has(group.rung);
          const showAll = searching || expanded.has(group.rung);
          const hiddenCount = group.rows.length - LEDGER_PREVIEW;
          return (
            <div
              key={group.rung}
              style={searching && matching.length === 0 ? { display: "none" } : undefined}
            >
              <button
                aria-expanded={isOpen}
                className={styles.ledgerHead}
                disabled={!folded || searching}
                onClick={() => flip(setOpen, group.rung)}
                type="button"
              >
                <span>
                  {folded && !searching ? (isOpen ? "▾ " : "▸ ") : ""}
                  {LIQUIDITY_TIER_LABELS[group.rung]}
                </span>
                <span>
                  {searching
                    ? `${matching.length} de ${group.rows.length}`
                    : group.rows.length}
                </span>
              </button>
              <div style={isOpen ? undefined : { display: "none" }}>
                {group.rows.map((row, index) => (
                  <LedgerRow
                    hidden={
                      !rowMatches(row, query) || (!showAll && index >= LEDGER_PREVIEW)
                    }
                    key={row.id}
                    row={row}
                    selected={selected.has(row.id)}
                    toggle={toggle}
                    twins={twins}
                  />
                ))}
                {!searching && hiddenCount > 0 ? (
                  <button
                    className={styles.ledgerMore}
                    onClick={() => flip(setExpanded, group.rung)}
                    type="button"
                  >
                    {expanded.has(group.rung)
                      ? "Ver solo los mayores"
                      : `Ver los ${hiddenCount} restantes`}
                  </button>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
      {searching &&
      groups.every((group) => !group.rows.some((row) => rowMatches(row, query))) ? (
        <p className={styles.empty}>Ningún activo coincide con «{query.trim()}».</p>
      ) : null}
    </div>
  );
}

// ── C · Buscar y añadir ────────────────────────────────────────────────────

const SUGGESTIONS = 8;
const RESULTS = 10;

function VariantC({ rows, selected, toggle, twins }: VariantProps) {
  const [query, setQuery] = useState("");
  const searching = query.trim() !== "";
  const chosen = rows.filter((row) => selected.has(row.id));
  const candidates = rows.filter((row) => !selected.has(row.id));
  const byValue = [...candidates].sort((a, b) => b.valueMinor - a.valueMinor);
  const matches = searching ? byValue.filter((row) => rowMatches(row, query)) : [];
  const suggestions = byValue
    .filter((row) => row.rung === "cash" || row.rung === "market")
    .slice(0, SUGGESTIONS);
  const shown = searching ? matches.slice(0, RESULTS) : suggestions;

  return (
    <div className={styles.stack}>
      {chosen.map((row) => (
        <input key={row.id} name="assetIds" type="hidden" value={row.id} />
      ))}
      {chosen.length > 0 ? (
        <div className={styles.chips}>
          {chosen.map((row) => {
            const code = discriminatorFor(row, twins);
            return (
              <span className={styles.chip} data-checked key={row.id}>
                <span aria-hidden="true" className={styles.chipMark} />
                <span>{row.name}</span>
                {code ? <span className={styles.chipCode}>{code}</span> : null}
                <span className={styles.chipValue}>{row.valueLabel}</span>
                <button
                  aria-label={`Quitar ${row.name}`}
                  className={styles.chipRemove}
                  onClick={() => toggle(row.id)}
                  type="button"
                >
                  ✕
                </button>
              </span>
            );
          })}
        </div>
      ) : (
        <p className={styles.empty}>Todavía no financia ningún activo.</p>
      )}
      <input
        className={styles.search}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) =>
          guardEnter(event, () => {
            const first = shown[0];
            if (searching && first) {
              toggle(first.id);
              setQuery("");
            }
          })
        }
        placeholder="Añade un activo: escribe su nombre o ISIN…"
        type="search"
        value={query}
      />
      <span className={styles.groupLabel}>
        {searching
          ? `${matches.length} ${matches.length === 1 ? "coincidencia" : "coincidencias"}${
              matches.length > RESULTS ? ` · se ven ${RESULTS}, afina la búsqueda` : ""
            }`
          : "Sugerencias · los mayores de Caja y Mercado"}
      </span>
      <div className={styles.results}>
        {shown.map((row) => {
          const code = discriminatorFor(row, twins);
          return (
            <button
              className={styles.result}
              key={row.id}
              onClick={() => {
                toggle(row.id);
                setQuery("");
              }}
              type="button"
            >
              <span className={styles.resultAdd}>+</span>
              <span className={styles.ledgerName}>
                {row.name}
                {code ? <span className={styles.ledgerCode}>{code}</span> : null}
              </span>
              <span className={styles.resultRung}>{LIQUIDITY_TIER_LABELS[row.rung]}</span>
              <span className={styles.ledgerValue}>{row.valueLabel}</span>
            </button>
          );
        })}
        {searching && matches.length === 0 ? (
          <p className={styles.empty}>Ningún activo coincide con «{query.trim()}».</p>
        ) : null}
      </div>
    </div>
  );
}

// ── Barra y montaje ────────────────────────────────────────────────────────

function PrototypeSwitcher({
  current,
  onChange,
}: {
  current: VariantKey;
  onChange: (variant: VariantKey) => void;
}) {
  const index = Math.max(
    0,
    VARIANTS.findIndex((variant) => variant.key === current),
  );
  const cycle = useCallback(
    (step: number) => {
      const next = VARIANTS[(index + step + VARIANTS.length) % VARIANTS.length];
      if (next) onChange(next.key);
    },
    [index, onChange],
  );

  useEffect(() => {
    function onKey(event: globalThis.KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable]")) return;
      if (event.key === "ArrowLeft") cycle(-1);
      if (event.key === "ArrowRight") cycle(1);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [cycle]);

  return (
    <div aria-label="Variantes del prototipo" className={styles.switcher} role="group">
      <button aria-label="Variante anterior" onClick={() => cycle(-1)} type="button">
        ←
      </button>
      <span>
        <span className={styles.switcherPrefix}>Prototipo #1527 · </span>
        {VARIANTS[index]?.key} ({VARIANTS[index]?.name})
      </span>
      <button aria-label="Variante siguiente" onClick={() => cycle(1)} type="button">
        →
      </button>
    </div>
  );
}

export default function SelectorPrototype({
  catalogs,
  initialCatalog,
  initialVariant,
}: {
  catalogs: Record<CatalogKey, CatalogRow[]>;
  initialCatalog: CatalogKey;
  initialVariant: VariantKey;
}) {
  const [variant, setVariant] = useState<VariantKey>(initialVariant);
  const [catalog, setCatalog] = useState<CatalogKey>(initialCatalog);
  const [scenario, setScenario] = useState<Scenario>("crear");
  const rows = catalogs[catalog];
  const initialIds = useMemo(
    () => (scenario === "editar" ? editScenarioIds(rows) : []),
    [rows, scenario],
  );
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set(initialIds));
  // «Marcados primero» se decide al cargar (canon #1483): lo que se marca después
  // se queda donde estaba, para que la lista no baile bajo el dedo.
  const [pinned, setPinned] = useState<ReadonlySet<string>>(new Set(initialIds));
  const [posted, setPosted] = useState<string[] | null>(null);
  const twins = useMemo(() => twinNames(rows), [rows]);

  useEffect(() => {
    setSelected(new Set(initialIds));
    setPinned(new Set(initialIds));
    setPosted(null);
  }, [initialIds]);

  const syncUrl = (next: { variante?: VariantKey; catalogo?: CatalogKey }) => {
    const url = new URL(window.location.href);
    if (next.variante) url.searchParams.set("variante", next.variante);
    if (next.catalogo) url.searchParams.set("catalogo", next.catalogo);
    window.history.replaceState(null, "", url);
  };

  const changeVariant = useCallback((next: VariantKey) => {
    setVariant(next);
    const url = new URL(window.location.href);
    url.searchParams.set("variante", next);
    window.history.replaceState(null, "", url);
  }, []);

  const toggle = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const nameById = new Map(rows.map((row) => [row.id, row.name]));
  const props: VariantProps = { pinned, rows, selected, toggle, twins };

  return (
    <section className={`section ${styles.prototype}`}>
      <div className={styles.controls}>
        <strong>Prototipo #1527 · selector de catálogo largo</strong>
        <span>
          Catálogo:{" "}
          {(["sintetico", "real"] as const).map((key) => (
            <button
              aria-pressed={catalog === key}
              key={key}
              onClick={() => {
                setCatalog(key);
                syncUrl({ catalogo: key });
              }}
              type="button"
            >
              {key === "sintetico"
                ? `Sintético (${catalogs.sintetico.length})`
                : `El tuyo (${catalogs.real.length})`}
            </button>
          ))}
        </span>
        <span>
          Escenario:{" "}
          {(["crear", "editar"] as const).map((key) => (
            <button
              aria-pressed={scenario === key}
              key={key}
              onClick={() => setScenario(key)}
              type="button"
            >
              {key === "crear" ? "Crear (nada marcado)" : "Editar (3 marcados)"}
            </button>
          ))}
        </span>
      </div>

      <form
        className="stackForm"
        onSubmit={(event) => {
          event.preventDefault();
          setPosted(new FormData(event.currentTarget).getAll("assetIds").map(String));
        }}
      >
        <span className="memberProfileLabel">
          Elige qué activos financian el objetivo
        </span>
        {variant === "A" ? <VariantA key={`${catalog}-${scenario}`} {...props} /> : null}
        {variant === "B" ? <VariantB key={`${catalog}-${scenario}`} {...props} /> : null}
        {variant === "C" ? <VariantC key={`${catalog}-${scenario}`} {...props} /> : null}
        {variant === "D" ? <VariantD key={`${catalog}-${scenario}`} {...props} /> : null}
        <button className={styles.submit} type="submit">
          Crear objetivo (no guarda: enseña lo que enviaría)
        </button>
      </form>

      <dl className={styles.state}>
        <dt>Marcados ({selected.size})</dt>
        <dd>
          {selected.size === 0
            ? "—"
            : [...selected].map((id) => nameById.get(id) ?? id).join(" · ")}
        </dd>
        <dt>Lo que enviaría el formulario</dt>
        <dd>
          {posted === null
            ? "pulsa «Crear objetivo»"
            : posted.length === 0
              ? "ningún assetIds"
              : `${posted.length} assetIds: ${posted
                  .map((id) => nameById.get(id) ?? id)
                  .join(" · ")}`}
        </dd>
      </dl>

      <PrototypeSwitcher current={variant} onChange={changeVariant} />
    </section>
  );
}
