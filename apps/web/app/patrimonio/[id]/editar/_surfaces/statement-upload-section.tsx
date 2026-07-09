"use client";

/**
 * Statement upload — the "Cargar movimientos" surface (ADR 0018, S1 #174 → S3 #176).
 *
 * Sits under the operations editor on a `derived` investment. Upload the Worthline
 * plantilla (CSV) or a broker export converted to it, then **preview before confirm**:
 * the first submit parses + builds the merge plan and shows what will change
 * ("N nuevas · M sobrescritas · K omitidas") WITHOUT writing; only the confirm
 * button applies the merge and ripples history.
 *
 * No server-side state holds the parsed file between steps — the file input
 * stays mounted the whole time, so the chosen file itself travels with each
 * submission and the confirm action re-validates it before writing. The preview
 * submit bypasses React's form-action path (onSubmit + preventDefault + manual
 * dispatch) because React 19 resets uncontrolled fields — including the file
 * input — after a form action runs, which would drop the file before confirm.
 * The confirm button goes through `formAction`, where the post-action reset is
 * harmless because a successful load redirects away. Mirrors ImportWorkspaceForm.
 */

import type { StatementPreviewState } from "@web/inversiones/actions";
import { startTransition, useActionState, useState } from "react";

const IDLE: StatementPreviewState = { status: "idle" };

function count(n: number, singular: string, plural: string): string {
  return `${n} ${n === 1 ? singular : plural}`;
}

export function StatementUploadSection({
  previewAction,
  confirmAction,
  currentUrl,
}: {
  previewAction: (
    prev: StatementPreviewState,
    formData: FormData,
  ) => Promise<StatementPreviewState>;
  confirmAction: (formData: FormData) => Promise<void>;
  currentUrl: string;
}) {
  const [preview, dispatchPreview, isPreviewPending] = useActionState(
    previewAction,
    IDLE,
  );
  const [fileChangedSincePreview, setFileChangedSincePreview] = useState(false);

  const shown = fileChangedSincePreview || isPreviewPending ? IDLE : preview;

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    const submitter = (event.nativeEvent as SubmitEvent).submitter;
    const isPreview =
      submitter instanceof HTMLButtonElement && submitter.value === "preview";

    if (!isPreview) return;

    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    setFileChangedSincePreview(false);
    startTransition(() => dispatchPreview(formData));
  }

  return (
    <section aria-label="Cargar movimientos">
      <h3>Cargar movimientos</h3>
      <p className="contextLabel">
        Sube la plantilla de Worthline (o un CSV con la misma forma) para crear las
        operaciones de esta inversión.
      </p>

      <form className="stackForm inversionesForm" onSubmit={handleSubmit}>
        <input name="currentUrl" type="hidden" value={currentUrl} />
        <input name="broker" type="hidden" value="plantilla" />

        <label>
          Archivo de operaciones (.csv)
          <input
            accept=".csv,text/csv"
            name="file"
            onChange={() => setFileChangedSincePreview(true)}
            required
            type="file"
          />
        </label>

        <p className="infoNote">
          ¿Tu bróker no exporta bien?{" "}
          <a download href="/plantilla-operaciones.csv">
            Descarga la plantilla
          </a>{" "}
          y rellénala: una fila por operación (Compra o Venta, importes siempre en
          positivo).
        </p>

        <button disabled={isPreviewPending} name="intent" type="submit" value="preview">
          Ver cambios
        </button>

        {shown.status === "error" ? (
          <div className="formError" role="alert">
            <p>No se puede cargar este archivo:</p>
            <p>{shown.message}</p>
          </div>
        ) : null}

        {shown.status === "summary" ? (
          <div className="importPreview">
            <p>Este archivo aplicará:</p>
            <ul className="importPreviewSummary">
              <li>{count(shown.created, "movimiento nuevo", "movimientos nuevos")}</li>
              <li>
                {count(
                  shown.overwritten,
                  "movimiento sobrescrito",
                  "movimientos sobrescritos",
                )}
              </li>
              <li>
                {count(shown.skipped, "movimiento omitido", "movimientos omitidos")}
              </li>
              {shown.sells > 0 ? (
                <li>{count(shown.sells, "venta detectada", "ventas detectadas")}</li>
              ) : null}
              {shown.anomalies > 0 ? (
                <li>
                  {count(
                    shown.anomalies,
                    "fecha con varias operaciones, sin tocar",
                    "fechas con varias operaciones, sin tocar",
                  )}
                </li>
              ) : null}
            </ul>

            {shown.anomalies > 0 ? (
              <p className="contextLabel">
                Hay fechas con más de una operación: no se sobrescriben para no tocar la
                fila equivocada. Revísalas a mano si hace falta.
              </p>
            ) : null}

            <button formAction={confirmAction} type="submit">
              Confirmar y cargar
            </button>
          </div>
        ) : null}
      </form>
    </section>
  );
}
