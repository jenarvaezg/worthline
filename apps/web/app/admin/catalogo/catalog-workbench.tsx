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
  type CatalogFilter,
  type CatalogViewState,
  catalogSearchString,
  countNeedsCategorizing,
  identityText,
  parseCatalogParams,
  profileCoverage,
  profileKey,
  profileNeedsCategorizing,
  visibleProfiles,
} from "./catalog-triage";

interface CatalogWorkbenchProps {
  initialProfiles: GlobalExposureProfile[];
  initialState: CatalogViewState;
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

  const rows = visibleProfiles(profiles, view);
  const triageCount = countNeedsCategorizing(profiles);
  const selected =
    view.selectedKey === null
      ? null
      : (profiles.find((p) => profileKey(p) === view.selectedKey) ?? null);

  function setFilter(filter: CatalogFilter) {
    setView((v) => ({ ...v, filter }));
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
            <label>
              <input
                checked={view.filter === "todos"}
                name="catalog-filter"
                onChange={() => setFilter("todos")}
                type="radio"
              />
              Todos
            </label>
            <label>
              <input
                checked={view.filter === "por-categorizar"}
                name="catalog-filter"
                onChange={() => setFilter("por-categorizar")}
                type="radio"
              />
              Por categorizar
            </label>
          </div>
          {triageCount > 0 ? (
            <p className="catalogTriageCount">{triageCount} por categorizar</p>
          ) : null}
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
                <th>Identidad</th>
                <th>Nombre</th>
                <th>Aviso</th>
                <th className="catalogNum">TER</th>
                <th>Índice</th>
                <th>Actualizado</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((profile) => {
                const key = profileKey(profile);
                const needs = profileNeedsCategorizing(profile);
                const avisoLabel = `Aviso: cobertura incompleta (${Math.round(profileCoverage(profile) * 100)}% declarado)`;
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
                      {needs ? (
                        // Not colour-only: the visible word «Aviso» is the label,
                        // `title` carries the coverage detail (#941).
                        <span className="catalogAviso" title={avisoLabel}>
                          Aviso
                        </span>
                      ) : (
                        <span className="catalogAvisoNone">—</span>
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
