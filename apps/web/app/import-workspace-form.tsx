"use client";

/**
 * Shared import flow (#104): pick file → preview (content summary + optional
 * data-loss warning) → confirm. Used from the /ajustes danger zone and, later,
 * from /empezar (#105) — hence the `showDataLossWarning` switch.
 *
 * No server-side state holds the parsed file between steps: the file input
 * stays mounted the whole time, so the chosen file itself travels with each
 * submission and the confirm action re-validates it before writing.
 *
 * The preview submit deliberately bypasses React's form-action path
 * (onSubmit + preventDefault + manual dispatch): React 19 resets uncontrolled
 * fields — including the file input — after a form action runs, which would
 * drop the chosen file before confirm. The confirm button does go through
 * `formAction={confirmImportAction}`, where the post-action reset is harmless
 * because a successful import redirects away.
 */

import type { WorkspaceExportSummary } from "@worthline/domain";
import { startTransition, useActionState, useState } from "react";

import {
  confirmImportAction,
  previewImportAction,
  type ImportPreviewState,
} from "./ajustes/actions";

export interface ImportWorkspaceFormProps {
  /**
   * Warn that confirming replaces (and loses) the current workspace. True
   * wherever a workspace already exists — e.g. always in /ajustes.
   */
  showDataLossWarning: boolean;
  /** Where confirm-time server errors should redirect back to (defaults to /ajustes). */
  currentUrl?: string;
}

const IDLE: ImportPreviewState = { status: "idle" };

function count(n: number, singular: string, plural: string): string {
  return `${n} ${n === 1 ? singular : plural}`;
}

function summaryLines(s: WorkspaceExportSummary): string[] {
  return [
    count(s.members, "miembro", "miembros"),
    count(s.groups, "grupo", "grupos"),
    count(s.assets, "activo", "activos"),
    count(s.liabilities, "pasivo", "pasivos"),
    count(s.operations, "operación", "operaciones"),
    count(s.snapshots, "snapshot", "snapshots"),
    `Papelera: ${count(s.trashedAssets, "activo", "activos")} y ${count(s.trashedLiabilities, "pasivo", "pasivos")}`,
    count(
      s.warningOverrides,
      "aviso marcado como intencional",
      "avisos marcados como intencionales",
    ),
    count(s.priceCacheEntries, "precio en caché", "precios en caché"),
    count(s.fireConfigScopes, "configuración FIRE", "configuraciones FIRE"),
  ];
}

export default function ImportWorkspaceForm({
  showDataLossWarning,
  currentUrl,
}: ImportWorkspaceFormProps) {
  const [preview, dispatchPreview, isPreviewPending] = useActionState(
    previewImportAction,
    IDLE,
  );
  // Picking a different file makes the last preview stale: hide it so a
  // summary of file A never blesses a confirm that would import file B.
  const [fileChangedSincePreview, setFileChangedSincePreview] = useState(false);

  const shown = fileChangedSincePreview || isPreviewPending ? IDLE : preview;

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    const submitter = (event.nativeEvent as SubmitEvent).submitter;
    const isPreview =
      submitter instanceof HTMLButtonElement && submitter.value === "preview";

    if (!isPreview) {
      // The confirm button carries no name/value (React forbids `name` on
      // buttons with a function formAction) — anything that isn't the preview
      // button goes through React's formAction={confirmImportAction} path.
      return;
    }

    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    setFileChangedSincePreview(false);
    startTransition(() => dispatchPreview(formData));
  }

  return (
    <form className="stackForm" onSubmit={handleSubmit}>
      {currentUrl ? <input name="currentUrl" type="hidden" value={currentUrl} /> : null}
      <label>
        Archivo de exportación (.json)
        <input
          accept="application/json,.json"
          name="file"
          onChange={() => setFileChangedSincePreview(true)}
          required
          type="file"
        />
      </label>
      <button disabled={isPreviewPending} name="intent" type="submit" value="preview">
        Ver contenido del archivo
      </button>

      {shown.status === "error" ? (
        <div className="formError" role="alert">
          <p>No se puede importar este archivo:</p>
          <ul className="importPreviewErrors">
            {shown.errors.map((error) => (
              <li key={error}>{error}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {shown.status === "summary" ? (
        <div className="importPreview">
          <p>El archivo contiene:</p>
          <ul className="importPreviewSummary">
            {summaryLines(shown.summary).map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>

          {showDataLossWarning ? (
            <p className="dangerExplain">
              Al confirmar, el workspace actual se reemplazará por completo y se
              perderá; nada de lo que existe ahora se conserva. Si quieres
              conservar una copia,{" "}
              <a className="panelAction" href="/ajustes/export">
                Exportar
              </a>{" "}
              antes de importar.
            </p>
          ) : null}

          <button formAction={confirmImportAction} type="submit">
            Importar y reemplazar
          </button>
        </div>
      ) : null}
    </form>
  );
}
