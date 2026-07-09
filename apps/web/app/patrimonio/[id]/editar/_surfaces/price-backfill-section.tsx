"use client";

/**
 * Historical-price backfill — the "Rellenar histórico de precios" surface
 * (#380, ADR 0033).
 *
 * Sits under the operations editor on a `derived` investment, rendered ONLY when
 * the asset is a backfill candidate (provider symbol + cost-basis history). Like
 * the statement upload, it is preview-then-confirm: the first submit fetches the
 * source's historical prices and shows what will change (N nuevos · M
 * actualizados, the source used, and the months it could NOT price) WITHOUT
 * writing; only the confirm button applies the backfill and ripples history.
 *
 * This is an EXPLICIT, auditable action — never a refresh side effect. The
 * preview submit bypasses React's form-action reset path (onSubmit +
 * preventDefault + manual dispatch) so the form state survives between steps,
 * exactly like StatementUploadSection.
 */

import type { PriceBackfillPreviewState } from "@web/inversiones/actions";
import { startTransition, useActionState } from "react";

const IDLE: PriceBackfillPreviewState = { status: "idle" };

function count(n: number, singular: string, plural: string): string {
  return `${n} ${n === 1 ? singular : plural}`;
}

/** es-ES short date for a YYYY-MM-DD gap month. */
function formatGap(dateKey: string): string {
  const [year, month] = dateKey.split("-");
  return `${month}/${year}`;
}

export function PriceBackfillSection({
  previewAction,
  confirmAction,
  currentUrl,
}: {
  previewAction: (
    prev: PriceBackfillPreviewState,
    formData: FormData,
  ) => Promise<PriceBackfillPreviewState>;
  confirmAction: (formData: FormData) => Promise<void>;
  currentUrl: string;
}) {
  const [preview, dispatchPreview, isPreviewPending] = useActionState(
    previewAction,
    IDLE,
  );

  const shown = isPreviewPending ? IDLE : preview;

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    const submitter = (event.nativeEvent as SubmitEvent).submitter;
    const isPreview =
      submitter instanceof HTMLButtonElement && submitter.value === "preview";

    if (!isPreview) {
      // The confirm button goes through React's formAction={confirmAction} path.
      return;
    }

    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    startTransition(() => dispatchPreview(formData));
  }

  return (
    <section aria-label="Rellenar histórico de precios">
      <h3>Rellenar histórico de precios</h3>
      <p className="contextLabel">
        Esta inversión tiene operaciones antiguas valoradas a coste porque no había
        cotización en esas fechas. Rellena el histórico con precios del proveedor para que
        el gráfico no dé un salto el día que entró el primer precio real.
      </p>

      <form className="stackForm inversionesForm" onSubmit={handleSubmit}>
        <input name="currentUrl" type="hidden" value={currentUrl} />

        <button disabled={isPreviewPending} name="intent" type="submit" value="preview">
          Ver cambios
        </button>

        {shown.status === "error" ? (
          <div className="formError" role="alert">
            <p>No se puede rellenar el histórico:</p>
            <p>{shown.message}</p>
          </div>
        ) : null}

        {shown.status === "not_eligible" ? (
          <p className="contextLabel">
            Esta inversión no admite relleno de histórico (sin símbolo de proveedor o sin
            histórico a coste).
          </p>
        ) : null}

        {shown.status === "summary" ? (
          <div className="importPreview">
            <p>
              Fuente: <strong>{shown.source}</strong>
            </p>
            {shown.create + shown.update === 0 ? (
              <p className="contextLabel">
                No hay precios históricos que aplicar en el rango de esta inversión.
              </p>
            ) : (
              <>
                <p>Este relleno aplicará:</p>
                <ul className="importPreviewSummary">
                  <li>{count(shown.create, "punto nuevo", "puntos nuevos")}</li>
                  <li>
                    {count(shown.update, "punto actualizado", "puntos actualizados")}
                  </li>
                </ul>
              </>
            )}

            {shown.gaps.length > 0 ? (
              <p className="contextLabel">
                La fuente no cubre {count(shown.gaps.length, "mes", "meses")} (
                {shown.gaps.map(formatGap).join(", ")}). Esos meses se quedan sin precio —
                no se inventa ninguno.
              </p>
            ) : null}

            {shown.create + shown.update > 0 ? (
              <button formAction={confirmAction} type="submit">
                Confirmar y rellenar
              </button>
            ) : null}
          </div>
        ) : null}
      </form>
    </section>
  );
}
