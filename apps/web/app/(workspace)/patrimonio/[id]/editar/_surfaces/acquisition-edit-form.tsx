"use client";

/**
 * The named acquisition editor, with a preview before the rewrite (#1437, #1562).
 *
 * Changing the acquisition date or price is not a field edit: it redraws the
 * whole interpolated stretch between the acquisition and the next appraisal — 22
 * years of curve in the measured case — and re-ripples every snapshot since.
 * That is a reconstruction, so it gets the reconstruction ceremony
 * (`import-schedule-preview`, #1406): «Ver cambios» asks the server what would
 * happen, the panel shows the two curves and the size of the rewrite, and the
 * confirm button's verb says what pressing it does.
 *
 * The preview never locks the button (ADR 0070 §4) — the user is the one who
 * knows the right acquisition date. It only stops being shown the moment a field
 * changes, so a stale answer is never what the confirm rides on; the confirm
 * re-reads the form on the server anyway.
 */

import type { AcquisitionEditPreviewState } from "@web/patrimonio/actions";
import {
  previewAcquisitionEditAction,
  updateValuationAnchorAction,
} from "@web/patrimonio/actions";
import { formatDateKeyEs, formatMoneyMinorPrivacy } from "@worthline/domain";
import { startTransition, useActionState, useState } from "react";
import { useFormStatus } from "react-dom";

import {
  acquisitionConfirmLabel,
  acquisitionDateRoleLabel,
  acquisitionRewriteSentence,
  acquisitionWorstMoveSentence,
} from "./acquisition-edit-view";

const IDLE: AcquisitionEditPreviewState = { status: "idle" };

function ConfirmSubmit({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return (
    <button
      aria-busy={pending}
      disabled={pending}
      formAction={updateValuationAnchorAction}
      type="submit"
    >
      {pending ? "Guardando…" : label}
    </button>
  );
}

export function AcquisitionEditForm({
  anchorId,
  assetId,
  currentUrl,
  defaultDate,
  defaultPrice,
  privacyMode = false,
  today,
}: {
  anchorId: string;
  /** Internal storage id — hidden form plumbing, never a URL (#1318). */
  assetId: string;
  currentUrl: string;
  defaultDate: string;
  /** The stored acquisition price, already formatted for the money input. */
  defaultPrice: string;
  /** Same masking the appraisals table honors — figures, not just totals. */
  privacyMode?: boolean;
  today: string;
}) {
  // The masking rides the same seam as the anchors table above (#605), so the
  // preview cannot be the one surface that shows the figures in privacy mode.
  const formatEur = (minor: number): string =>
    formatMoneyMinorPrivacy({ amountMinor: minor, currency: "EUR" }, privacyMode);
  /** Signed difference, so a row that holds reads «—» instead of «0,00 €». */
  const formatDelta = (deltaMinor: number): string =>
    deltaMinor === 0
      ? "—"
      : `${deltaMinor > 0 ? "+" : "−"}${formatEur(Math.abs(deltaMinor))}`;
  const [preview, dispatchPreview, isPreviewPending] = useActionState(
    previewAcquisitionEditAction,
    IDLE,
  );
  const [editedSincePreview, setEditedSincePreview] = useState(false);

  const shown = editedSincePreview || isPreviewPending ? IDLE : preview;
  const worstMove =
    shown.status === "summary"
      ? acquisitionWorstMoveSentence(shown.preview, formatEur)
      : null;

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    const submitter = (event.nativeEvent as SubmitEvent).submitter;
    if (!(submitter instanceof HTMLButtonElement && submitter.value === "preview")) {
      // The confirm rides React's formAction={updateValuationAnchorAction} path.
      return;
    }
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    setEditedSincePreview(false);
    startTransition(() => dispatchPreview(formData));
  }

  return (
    <form aria-label="Editar adquisición" className="stackForm" onSubmit={handleSubmit}>
      <input name="currentUrl" type="hidden" value={currentUrl} />
      <input name="id" type="hidden" value={assetId} />
      <input name="anchorId" type="hidden" value={anchorId} />
      <label>
        Fecha de adquisición
        <input
          aria-label="Fecha de adquisición"
          defaultValue={defaultDate}
          max={today}
          name="valuationDate"
          onChange={() => setEditedSincePreview(true)}
          required
          type="date"
        />
      </label>
      <label>
        Precio de adquisición (EUR)
        <input
          aria-label="Precio de adquisición en EUR"
          defaultValue={defaultPrice}
          inputMode="decimal"
          min="0"
          name="anchorValue"
          onChange={() => setEditedSincePreview(true)}
          required
        />
      </label>
      <p className="infoNote">
        La fecha de adquisición marca desde cuándo el inmueble existe en el histórico;
        cambiarla reescribe su curva de valor desde entonces. Mira los cambios antes de
        guardar.
      </p>

      <button disabled={isPreviewPending} name="intent" type="submit" value="preview">
        Ver cambios
      </button>

      <div aria-live="polite">
        {shown.status === "error" ? (
          <div className="formError" role="alert">
            <p>No se puede cambiar la adquisición:</p>
            <p>{shown.message}</p>
          </div>
        ) : null}

        {shown.status === "summary" ? (
          <div className="importPreview">
            <p>{acquisitionRewriteSentence(shown.preview)}</p>
            {worstMove !== null ? <p>{worstMove}</p> : null}

            <div className="tableScroll">
              <table aria-label="Curva antes y después">
                <thead>
                  <tr>
                    <th scope="col">Fecha</th>
                    <th scope="col">Qué es</th>
                    <th className="numCol" scope="col">
                      Ahora
                    </th>
                    <th className="numCol" scope="col">
                      Después
                    </th>
                    <th className="numCol" scope="col">
                      Diferencia
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {shown.preview.points.map((point) => (
                    <tr key={point.dateKey}>
                      <td>{formatDateKeyEs(point.dateKey)}</td>
                      <td>{acquisitionDateRoleLabel(point.role, shown.preview)}</td>
                      <td className="numCol">{formatEur(point.beforeMinor)}</td>
                      <td className="numCol">{formatEur(point.afterMinor)}</td>
                      <td className="numCol">{formatDelta(point.deltaMinor)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <ConfirmSubmit label={acquisitionConfirmLabel(shown.preview)} />
          </div>
        ) : null}
      </div>
    </form>
  );
}
