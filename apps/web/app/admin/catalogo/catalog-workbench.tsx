"use client";

/**
 * The catalog admin workbench (PRD #711 S4, decision #941): a full-width triage
 * register on the left and a detail/edit panel on the right, on one screen with
 * no navigation between views. Selecting a row, switching the triage filter, or
 * searching are client-side view changes mirrored to the URL (interaction-
 * patterns §2/§3), so a deep-link and the Back button still work. Mutations go
 * through the server actions; the persisted record they return updates the list
 * in place (read-after-write, #943) without a page reload.
 *
 * All triage math lives in the pure, tested `catalog-triage` module — this
 * component is the thin shell (interaction-patterns §7).
 */

import type { GlobalExposureProfile } from "@worthline/domain";
import { useCallback, useEffect, useRef, useState } from "react";

import type { CatalogActionResult } from "./actions";
import {
  CatalogDeleteForm,
  CatalogRekeyForm,
  CatalogSaveForm,
} from "./catalog-profile-editor";
import {
  asOfIsStale,
  asOfSortKey,
  asOfText,
  CATALOG_FILTER_OPTIONS,
  CATALOG_LENSES,
  type CatalogDimension,
  type CatalogFilter,
  type CatalogSort,
  type CatalogViewState,
  catalogSearchString,
  confidenceText,
  countMatching,
  identityText,
  MATERIAL_GAP_THRESHOLD,
  parseCatalogParams,
  profileKey,
  profileNeedsCategorizing,
  profileWorstGap,
  STALE_AS_OF_MONTHS,
  UNDECLARED_TEXT,
  visibleProfiles,
} from "./catalog-triage";

interface CatalogWorkbenchProps {
  initialProfiles: GlobalExposureProfile[];
  initialState: CatalogViewState;
  /** The day the register is read, from the server (`YYYY-MM-DD`) — never `new Date()` here. */
  today: string;
}

/**
 * What each order is called out loud. Said separately from the column label
 * because a header word and an ordering are not the same thing: the «Aviso»
 * column orders by declared coverage.
 */
const SORT_TITLES: Record<CatalogSort, string> = {
  identidad: "identidad",
  cobertura: "cobertura declarada",
  confianza: "confianza",
  corte: "antigüedad del corte",
};

/** The dimension said out loud, for the «Aviso» cell's title (#1678). */
const DIMENSION_NAMES: Record<CatalogDimension, string> = {
  geography: "geografía",
  currency: "divisa",
  assetClass: "clase de activo",
};

/** A gap as the register prints it: one decimal, so 0,3% never reads as 0%. */
function formatGap(remainder: number): string {
  return `${(Math.round(remainder * 1000) / 10).toLocaleString("es-ES")}%`;
}

/** The counters shown beside the filter — the lenses that name a problem. */
const COUNTED_LENSES: readonly CatalogFilter[] = [
  "por-categorizar",
  "confianza-baja",
  "corte-antiguo",
];

/**
 * A column header that also reads the register in its own order. `aria-sort`
 * carries the state for a screen reader, so the order is not conveyed by the
 * arrow alone; pressing the active one again releases it back to the lens's
 * order (§8, #1508).
 */
function SortableHeader({
  activeSort,
  label,
  onSort,
  sort,
}: {
  activeSort: CatalogSort;
  label: string;
  onSort: (sort: CatalogSort) => void;
  sort: CatalogSort;
}) {
  const isActive = activeSort === sort;
  return (
    <th aria-sort={isActive ? "ascending" : "none"}>
      <button
        className={isActive ? "catalogSortButton isActive" : "catalogSortButton"}
        onClick={() => onSort(sort)}
        title={
          isActive
            ? `Ordenado por ${SORT_TITLES[sort]}, lo más urgente primero. Pulsa para volver al orden del filtro.`
            : `Ordenar por ${SORT_TITLES[sort]}, lo más urgente primero`
        }
        type="button"
      >
        {label}
        {isActive ? <span aria-hidden="true"> ↓</span> : null}
      </button>
    </th>
  );
}

function formatUpdatedAt(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? "—"
    : date.toLocaleDateString("es-ES", {
        day: "2-digit",
        month: "short",
        year: "numeric",
      });
}

export default function CatalogWorkbench({
  initialProfiles,
  initialState,
  today,
}: CatalogWorkbenchProps) {
  const [profiles, setProfiles] = useState(initialProfiles);
  const [view, setView] = useState<CatalogViewState>(initialState);
  const [creating, setCreating] = useState(false);
  const previousSelected = useRef<string | null>(initialState.selectedKey);
  const detailRef = useRef<HTMLElement>(null);

  // Mirror view state to the URL: a new history entry when the selection
  // changes (so Back deselects), an in-place replace for filter/search churn.
  useEffect(() => {
    const url = `${window.location.pathname}${catalogSearchString(view)}`;
    if (view.selectedKey !== previousSelected.current) {
      window.history.pushState(null, "", url);
    } else {
      window.history.replaceState(null, "", url);
    }
    previousSelected.current = view.selectedKey;
  }, [view]);

  useEffect(() => {
    function onPopState() {
      const params = new URLSearchParams(window.location.search);
      const next = parseCatalogParams({
        filtro: params.get("filtro"),
        orden: params.get("orden"),
        q: params.get("q"),
        perfil: params.get("perfil"),
      });
      previousSelected.current = next.selectedKey;
      setView(next);
      setCreating(false);
    }
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  // Selecting a row or starting a draft is a client toggle, not a navigation,
  // so a screen reader would not announce the new detail on its own (§8): move
  // focus to the detail pane, but not on the initial (deep-link) mount.
  const mounted = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: selectedKey/creating are the intended triggers; the effect reacts to them via refs rather than reading them.
  useEffect(() => {
    if (mounted.current) {
      detailRef.current?.focus();
    } else {
      mounted.current = true;
    }
  }, [view.selectedKey, creating]);

  const applyResult = useCallback((result: CatalogActionResult) => {
    if (result.status === "saved") {
      const key = profileKey(result.profile);
      setProfiles((prev) => {
        const dropped = new Set([key, result.previousKey ?? ""]);
        return [...prev.filter((p) => !dropped.has(profileKey(p))), result.profile];
      });
      setCreating(false);
      setView((v) => ({ ...v, selectedKey: key }));
    } else if (result.status === "deleted") {
      setProfiles((prev) => prev.filter((p) => profileKey(p) !== result.identityKey));
      setView((v) => ({ ...v, selectedKey: null }));
    }
  }, []);

  const rows = visibleProfiles(profiles, view, today);
  const activeSort = view.sort ?? CATALOG_LENSES[view.filter].defaultSort;
  const selected =
    view.selectedKey === null
      ? null
      : (profiles.find((p) => profileKey(p) === view.selectedKey) ?? null);

  function setFilter(filter: CatalogFilter) {
    setView((v) => ({ ...v, filter }));
  }

  // Clicking the same column header again releases the explicit order and hands
  // the list back to the lens's own worst-first reading.
  function toggleSort(sort: CatalogSort) {
    setView((v) => ({ ...v, sort: v.sort === sort ? null : sort }));
  }

  function selectProfile(key: string) {
    setCreating(false);
    setView((v) => ({ ...v, selectedKey: key }));
  }

  function startCreate() {
    setCreating(true);
    setView((v) => ({ ...v, selectedKey: null }));
  }

  return (
    <div className="catalogWorkbench">
      <section className="catalogListPane section">
        <div className="catalogListHead">
          <div className="segmented catalogFilter" role="group" aria-label="Filtro">
            {CATALOG_FILTER_OPTIONS.map(({ filter, label }) => (
              <label key={filter}>
                <input
                  checked={view.filter === filter}
                  name="catalog-filter"
                  onChange={() => setFilter(filter)}
                  type="radio"
                />
                {label}
              </label>
            ))}
          </div>
          <div className="catalogCounts">
            {COUNTED_LENSES.map((filter) => {
              const count = countMatching(profiles, filter, today);
              return count > 0 ? (
                <p className="catalogTriageCount" key={filter}>
                  {CATALOG_LENSES[filter].countLabel(count)}
                </p>
              ) : null;
            })}
          </div>
        </div>

        <div className="catalogSearchRow">
          <input
            aria-label="Buscar por identidad o nombre"
            className="catalogSearch"
            onChange={(e) => setView((v) => ({ ...v, query: e.target.value }))}
            placeholder="Buscar identidad o nombre…"
            type="search"
            value={view.query}
          />
          <button className="btnSmall" onClick={startCreate} type="button">
            Nuevo perfil
          </button>
        </div>

        {rows.length === 0 ? (
          <p className="catalogEmpty">Sin perfiles que coincidan.</p>
        ) : (
          <table className="catalogTable">
            <thead>
              <tr>
                <SortableHeader
                  activeSort={activeSort}
                  label="Identidad"
                  onSort={toggleSort}
                  sort="identidad"
                />
                <th>Nombre</th>
                <SortableHeader
                  activeSort={activeSort}
                  label="Aviso"
                  onSort={toggleSort}
                  sort="cobertura"
                />
                <SortableHeader
                  activeSort={activeSort}
                  label="Confianza"
                  onSort={toggleSort}
                  sort="confianza"
                />
                <SortableHeader
                  activeSort={activeSort}
                  label="Corte"
                  onSort={toggleSort}
                  sort="corte"
                />
                <th className="catalogNum">TER</th>
                <th>Índice</th>
                <th>Actualizado</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((profile) => {
                const key = profileKey(profile);
                const needs = profileNeedsCategorizing(profile);
                const gap = profileWorstGap(profile);
                const avisoLabel = gap
                  ? `Sin declarar ${formatGap(gap.remainder)} en ${DIMENSION_NAMES[gap.dimension]}${needs ? "" : ` — por debajo del ${formatGap(MATERIAL_GAP_THRESHOLD)} que el registro pide mirar`}`
                  : "Cobertura completa en las tres dimensiones";
                const isSelected = key === view.selectedKey;
                return (
                  <tr
                    className={isSelected ? "catalogRow isSelected" : "catalogRow"}
                    key={key}
                  >
                    <td>
                      <button
                        aria-current={isSelected ? "true" : undefined}
                        className="catalogRowButton"
                        onClick={() => selectProfile(key)}
                        type="button"
                      >
                        {identityText(profile.identity)}
                      </button>
                    </td>
                    <td>{profile.displayName ?? "—"}</td>
                    <td>
                      {/* The SIZE of the gap is on the row, not only in `title`
                          (#1678): three tenths must not read like thirty points.
                          Not colour-only — the number is the label. A gap below
                          the materiality threshold still shows, in muted text:
                          it is true, it is just not worth chasing. */}
                      {gap === null ? (
                        <span className="catalogAvisoNone">—</span>
                      ) : needs ? (
                        <span className="catalogAviso" title={avisoLabel}>
                          {formatGap(gap.remainder)}
                        </span>
                      ) : (
                        <span className="catalogAvisoNone" title={avisoLabel}>
                          {formatGap(gap.remainder)}
                        </span>
                      )}
                    </td>
                    <td>
                      {/* The gold mark exists only where a DECLARED state does:
                          «baja» is a read the admin made and can act on; «sin
                          declarar» is an absence, and it reads as muted text so
                          gold keeps meaning «hay algo declarado que mirar»
                          (design-system §6). */}
                      {profile.confidence === "baja" ? (
                        <span
                          className="catalogAviso"
                          title="Confianza baja: el vector lee el mandato del fondo, no su cartera"
                        >
                          baja
                        </span>
                      ) : profile.confidence === null ? (
                        <span className="catalogAvisoNone">{UNDECLARED_TEXT}</span>
                      ) : (
                        confidenceText(profile)
                      )}
                    </td>
                    <td>
                      {asOfSortKey(profile) === null ? (
                        <span className="catalogAvisoNone">{asOfText(profile)}</span>
                      ) : asOfIsStale(profile, today) ? (
                        <span
                          className="catalogAviso"
                          title={`Fecha de corte de los datos con más de ${STALE_AS_OF_MONTHS} meses: toca releer la fuente`}
                        >
                          {asOfText(profile)}
                        </span>
                      ) : (
                        asOfText(profile)
                      )}
                    </td>
                    <td className="catalogNum">{profile.ter ?? "—"}</td>
                    <td>{profile.trackedIndex ?? "—"}</td>
                    <td>{formatUpdatedAt(profile.updatedAt)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>

      <section className="catalogDetailPane section" ref={detailRef} tabIndex={-1}>
        {creating ? (
          <>
            <h2>Nuevo perfil</h2>
            <CatalogSaveForm mode="create" onResult={applyResult} profile={null} />
          </>
        ) : selected ? (
          <>
            <h2>{selected.displayName ?? identityText(selected.identity)}</h2>
            <CatalogSaveForm
              key={`save-${profileKey(selected)}`}
              mode="update"
              onResult={applyResult}
              profile={selected}
            />
            <div className="catalogDangerZone">
              <CatalogRekeyForm
                key={`rekey-${profileKey(selected)}`}
                onResult={applyResult}
                profile={selected}
              />
              <CatalogDeleteForm
                key={`delete-${profileKey(selected)}`}
                onResult={applyResult}
                profile={selected}
              />
            </div>
          </>
        ) : (
          <p className="catalogDetailEmpty">
            Selecciona un perfil de la lista para editarlo, o crea uno nuevo.
          </p>
        )}
      </section>
    </div>
  );
}
