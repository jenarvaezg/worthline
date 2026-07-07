"use client";

/**
 * Statement upload — the "Cargar movimientos" surface (ADR 0018, S1 #174 → S3 #176).
 *
 * Sits under the operations editor on a `derived` investment. Pick the broker
 * (MyInvestor only for now) and a `.csv` export, then **preview before confirm**:
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

import { startTransition, useActionState, useState } from "react";

import type { StatementPreviewState } from "@web/inversiones/actions";

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
  // Picking a different file makes the last preview stale: hide it so a summary
  // of file A never blesses a confirm that would load file B.
  const [fileChangedSincePreview, setFileChangedSincePreview] = useState(false);

  const shown = fileChangedSincePreview || isPreviewPending ? IDLE : preview;

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    const submitter = (event.nativeEvent as SubmitEvent).submitter;
    const isPreview =
      submitter instanceof HTMLButtonElement && submitter.value === "preview";

    if (!isPreview) {
      // The confirm button carries no name/value — it goes through React's
      // formAction={confirmAction} path.
      return;
    }

    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    setFileChangedSincePreview(false);
    startTransition(() => dispatchPreview(formData));
  }

  return (
    <section aria-label="Cargar movimientos">
      <h3>Cargar movimientos</h3>
      <p className="contextLabel">
        Sube el archivo de órdenes exportado por tu bróker para crear las operaciones de
        esta inversión.
      </p>

      <form className="stackForm inversionesForm" onSubmit={handleSubmit}>
        <input name="currentUrl" type="hidden" value={currentUrl} />

        <label>
          Bróker
          <select defaultValue="myinvestor" name="broker">
            <option value="myinvestor">MyInvestor</option>
          </select>
        </label>

        <label>
          Archivo de órdenes (.csv)
          <input
            accept=".csv,text/csv"
            name="file"
            onChange={() => setFileChangedSincePreview(true)}
            required
            type="file"
          />
        </label>

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
              {shown.sells > 0 && shown.directionResolved ? (
                // Only meaningful when the file carries the tipo column; under
                // the sign-rule fallback it would contradict the warning below.
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

            {!shown.directionResolved ? (
              <p className="warningBand" role="alert">
                Este archivo no indica si cada orden es compra o venta: todas se cargarán
                como compras. Si tienes ventas o reembolsos, exporta desde MyInvestor el
                archivo de órdenes que incluye la columna «Tipo de operación».
              </p>
            ) : null}

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
