"use client";

/**
 * PROTOTIPO #1527 — desechable. Variante D: la fusión de B y C.
 *
 * De C: arriba, lo elegido como chips con ✕, y un buscador que va primero (Enter
 * añade la coincidencia señalada). De B: debajo, el libro por peldaños con el valor
 * alineado; cada grupo enseña solo sus mayores —que hacen de sugerencias— y el
 * resto se despliega a demanda; Ilíquido y Vivienda, plegados.
 *
 * Las casillas del libro son la ÚNICA fuente de lo que se envía: una fila oculta
 * por el buscador o por «ver más» sigue montada, y se sigue enviando. Los chips de
 * arriba son un espejo sin inputs.
 */

import { LIQUIDITY_TIER_LABELS, type LiquidityTier } from "@worthline/domain";
import { type KeyboardEvent, type ReactNode, useRef, useState } from "react";
import {
  type CatalogRow,
  discriminatorFor,
  FOLDED_RUNGS,
  groupByRung,
  rowMatches,
} from "./prototype-model";
import styles from "./variant-d.module.css";

const PREVIEW = 5;

function flip<T>(set: ReadonlySet<T>, item: T): Set<T> {
  const next = new Set(set);
  if (next.has(item)) next.delete(item);
  else next.add(item);
  return next;
}

/** Resalta la coincidencia literal (sin tildes de por medio basta para el prototipo). */
function highlight(name: string, query: string): ReactNode {
  const needle = query.trim().toLowerCase();
  const at = needle === "" ? -1 : name.toLowerCase().indexOf(needle);
  if (at < 0) return name;
  return (
    <>
      {name.slice(0, at)}
      <mark className={styles.hit}>{name.slice(at, at + needle.length)}</mark>
      {name.slice(at + needle.length)}
    </>
  );
}

export function VariantD({
  rows,
  pinned,
  selected,
  toggle,
  twins,
}: {
  rows: CatalogRow[];
  pinned: ReadonlySet<string>;
  selected: ReadonlySet<string>;
  toggle: (id: string) => void;
  twins: ReadonlySet<string>;
}) {
  const [query, setQuery] = useState("");
  const [opened, setOpened] = useState<ReadonlySet<LiquidityTier>>(new Set());
  const [expanded, setExpanded] = useState<ReadonlySet<LiquidityTier>>(new Set());
  // Una fila que el usuario ha tocado no desaparece al plegar «ver más»: la lista no
  // se mueve bajo el dedo, ni para esconder lo que acaba de desmarcar.
  const [touched, setTouched] = useState<ReadonlySet<string>>(new Set());
  const [announcement, setAnnouncement] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const ledgerRef = useRef<HTMLDivElement>(null);

  const searching = query.trim() !== "";
  const rowById = new Map(rows.map((row) => [row.id, row]));
  const chosen = [...selected].flatMap((id) => rowById.get(id) ?? []);

  const groups = groupByRung(rows).map((group) => {
    const folded = FOLDED_RUNGS.has(group.rung);
    const matching = group.rows.filter((row) => rowMatches(row, query));
    const showAll = searching || expanded.has(group.rung);
    const visible = new Set(
      (searching
        ? matching
        : showAll
          ? group.rows
          : group.rows.filter(
              (row, index) =>
                index < PREVIEW || pinned.has(row.id) || touched.has(row.id),
            )
      ).map((row) => row.id),
    );
    return {
      ...group,
      chosenCount: group.rows.filter((row) => selected.has(row.id)).length,
      folded,
      hiddenCount: group.rows.length - visible.size,
      isOpen: searching ? matching.length > 0 : !folded || opened.has(group.rung),
      matchCount: matching.length,
      visible,
    };
  });

  const totalMatches = groups.reduce((sum, group) => sum + group.matchCount, 0);
  const target = searching
    ? groups
        .flatMap((group) => group.rows)
        .find((row) => rowMatches(row, query) && !selected.has(row.id))
    : undefined;

  const toggleRow = (row: CatalogRow, via: "fila" | "chip" | "enter") => {
    const adding = !selected.has(row.id);
    toggle(row.id);
    setTouched((prev) => new Set(prev).add(row.id));
    setAnnouncement(`${adding ? "Añadido" : "Quitado"}: ${row.name}`);
    if (via === "enter") setQuery("");
  };

  const onSearchKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      // Enter nunca envía el formulario: añade la fila señalada, si la hay.
      event.preventDefault();
      if (target) toggleRow(target, "enter");
    } else if (event.key === "Escape" && searching) {
      event.preventDefault();
      setQuery("");
    } else if (event.key === "ArrowDown") {
      const first = [...(ledgerRef.current?.querySelectorAll("input") ?? [])].find(
        (input) => input.offsetParent !== null,
      );
      if (first) {
        event.preventDefault();
        first.focus();
      }
    }
  };

  return (
    <div className={styles.root}>
      <div className={styles.chosen}>
        {chosen.length > 0 ? (
          <ul className={styles.chips}>
            {chosen.map((row) => {
              const code = discriminatorFor(row, twins);
              return (
                <li className={styles.chip} key={row.id}>
                  <span className={styles.chipName}>{row.name}</span>
                  {code ? <span className={styles.code}>{code}</span> : null}
                  <span className={styles.chipValue}>{row.valueLabel}</span>
                  <button
                    aria-label={`Quitar ${row.name}`}
                    className={styles.chipRemove}
                    onClick={() => toggleRow(row, "chip")}
                    type="button"
                  >
                    ×
                  </button>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className={styles.empty}>
            Aún no has elegido ningún activo. Búscalo o márcalo en la lista.
          </p>
        )}
      </div>

      <div className={styles.searchBar}>
        <input
          aria-describedby="proto-1527-search-hint"
          aria-label="Buscar un activo"
          className={styles.search}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={onSearchKey}
          placeholder="Busca por nombre o ISIN"
          ref={searchRef}
          type="search"
          value={query}
        />
        <p className={styles.hint} id="proto-1527-search-hint">
          {searching ? (
            target ? (
              <>
                <kbd>Enter</kbd> añade <strong>{target.name}</strong>
                {discriminatorFor(target, twins)
                  ? ` (${discriminatorFor(target, twins)})`
                  : ""}
                {totalMatches > 1 ? ` · ${totalMatches} coincidencias` : ""}
              </>
            ) : totalMatches > 0 ? (
              `${totalMatches} ${totalMatches === 1 ? "coincidencia, ya elegida" : "coincidencias, todas elegidas"}`
            ) : (
              "Ninguna coincidencia"
            )
          ) : (
            `${rows.length} activos · los mayores de cada grupo primero`
          )}
        </p>
      </div>

      <div className={styles.ledger} ref={ledgerRef}>
        {groups.map((group) => {
          const label = LIQUIDITY_TIER_LABELS[group.rung];
          const meta = (
            <span className={styles.groupMeta}>
              {group.chosenCount > 0 ? (
                <span className={styles.groupChosen}>
                  {group.chosenCount} {group.chosenCount === 1 ? "elegido" : "elegidos"}
                </span>
              ) : null}
              <span className={styles.count}>
                {searching
                  ? `${group.matchCount} de ${group.rows.length}`
                  : group.rows.length}
              </span>
            </span>
          );
          return (
            <section
              className={styles.group}
              hidden={searching && group.matchCount === 0}
              key={group.rung}
            >
              {group.folded && !searching ? (
                <button
                  aria-expanded={group.isOpen}
                  className={`${styles.head} ${styles.groupHead} ${styles.groupToggle}`}
                  onClick={() => setOpened((prev) => flip(prev, group.rung))}
                  type="button"
                >
                  <span>
                    <span aria-hidden="true" className={styles.caret}>
                      {group.isOpen ? "▾" : "▸"}
                    </span>
                    {label}
                  </span>
                  {meta}
                </button>
              ) : (
                <div className={`${styles.head} ${styles.groupHead}`}>
                  <span>{label}</span>
                  {meta}
                </div>
              )}
              <div hidden={!group.isOpen}>
                {group.rows.map((row) => {
                  const code = discriminatorFor(row, twins);
                  return (
                    <label
                      className={styles.row}
                      data-checked={selected.has(row.id) || undefined}
                      data-target={row.id === target?.id || undefined}
                      hidden={!group.visible.has(row.id)}
                      key={row.id}
                    >
                      <input
                        checked={selected.has(row.id)}
                        name="assetIds"
                        onChange={() => toggleRow(row, "fila")}
                        type="checkbox"
                        value={row.id}
                      />
                      <span className={styles.rowName}>
                        {highlight(row.name, query)}
                        {code ? <span className={styles.code}>{code}</span> : null}
                      </span>
                      <span className={styles.rowValue}>{row.valueLabel}</span>
                    </label>
                  );
                })}
                {!searching && (group.hiddenCount > 0 || expanded.has(group.rung)) ? (
                  <button
                    className={styles.more}
                    onClick={() => setExpanded((prev) => flip(prev, group.rung))}
                    type="button"
                  >
                    {expanded.has(group.rung)
                      ? `Ver solo los ${PREVIEW} mayores`
                      : `Ver ${group.hiddenCount} más de ${label}`}
                  </button>
                ) : null}
              </div>
            </section>
          );
        })}
        {searching && totalMatches === 0 ? (
          <p className={styles.noMatch}>
            Ningún activo coincide con «{query.trim()}».{" "}
            <button
              className={styles.more}
              onClick={() => {
                setQuery("");
                searchRef.current?.focus();
              }}
              type="button"
            >
              Borrar la búsqueda
            </button>
          </p>
        ) : null}
      </div>

      <p aria-live="polite" className={styles.srOnly}>
        {announcement}
      </p>
    </div>
  );
}
