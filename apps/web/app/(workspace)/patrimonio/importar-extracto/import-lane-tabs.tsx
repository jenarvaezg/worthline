"use client";

import { useUrlViewParam } from "@web/url-view-state";
import { IMPORT_DOCUMENT_VIEW_PARAM, type ImportDocumentKind } from "@web/view-state";
import type { ReactNode } from "react";

/**
 * The document-type switch of «Importar extracto» (#1406): one door, two readers.
 *
 * The server renders BOTH lanes and this island shows the active one — no
 * round-trip, scroll kept, `documento` mirrored to the URL via `pushState`
 * (interaction-patterns §2/§3). The tabs stay real `<a href>`, so the deep-link
 * `?documento=cuadro` — the one the plantilla's «Hipoteca» error points at — works
 * with JS off and from the keyboard (§8).
 */

const TABS: readonly { id: ImportDocumentKind; label: string }[] = [
  { id: "operaciones", label: "Operaciones" },
  { id: "cuadro", label: "Cuadro de amortización" },
];

export function ImportLaneTabs({
  basePath,
  initialDocument,
  operaciones,
  cuadro,
}: {
  basePath: string;
  initialDocument: ImportDocumentKind;
  operaciones: ReactNode;
  cuadro: ReactNode;
}) {
  const [documentKind, , select] = useUrlViewParam(
    IMPORT_DOCUMENT_VIEW_PARAM,
    initialDocument,
  );

  const activeLabel = TABS.find((tab) => tab.id === documentKind)?.label ?? "";

  return (
    <>
      <nav aria-label="Tipo de documento" className="framingTabs">
        {TABS.map((tab) => {
          const isActive = tab.id === documentKind;
          return (
            <a
              aria-current={isActive ? "true" : undefined}
              className={isActive ? "active" : undefined}
              href={
                tab.id === "operaciones" ? basePath : `${basePath}?documento=${tab.id}`
              }
              key={tab.id}
              onClick={select(tab.id)}
            >
              {tab.label}
            </a>
          );
        })}
      </nav>
      {/* A client toggle is not a document navigation, so it is not announced (§8). */}
      <p aria-live="polite" className="srOnly">{`Documento: ${activeLabel}`}</p>
      {documentKind === "cuadro" ? cuadro : operaciones}
    </>
  );
}
